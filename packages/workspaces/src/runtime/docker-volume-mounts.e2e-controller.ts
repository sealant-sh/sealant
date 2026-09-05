/**
 * In-container half of docker-volume-mounts.e2e.ts. The host test bundles this file with esbuild;
 * all workspace launches and daemon control requests below run inside that Linux controller.
 */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";

import { Effect } from "effect";
import { z } from "zod";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../sealantd/runtime.js";
import { execInWorkspace } from "../sealantd/target.js";
import {
  DockerRuntimeAdapter,
  type DockerRuntimeAdapterOptions,
} from "./docker-runtime-adapter.js";
import { parseDockerVolumeMappings } from "./docker-volume-mounts.js";
import { bindRootMountPath } from "./mount-intent.js";
import {
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
} from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);

const STORE_ROOT = "/sealant/store";
const CONTROL_ROOT = "/sealant/control";
const STAGING_ROOT = "/sealant/staging";
const WORKTREE = `${STORE_ROOT}/project/worktrees/session-1`;
const COMMON_DIR = `${STORE_ROOT}/project/repo.git`;
const REFERENCE_DIR = `${STORE_ROOT}/_references/lib`;
const HOME_DIR = `${STORE_ROOT}/harness-home`;
const SESSION_DIR = `${STORE_ROOT}/_run/sessions/1`;
const BINDABLE_ROOT = `${STORE_ROOT}/bindable`;
const STANDBY_ROOT = `${STORE_ROOT}/standby`;
const DOTFILES_DIR = `${STAGING_ROOT}/dotfiles/primary`;
const SECRET_ENV_DIR = `${STAGING_ROOT}/secrets/primary`;
const SESSION_SOCKET = `${SESSION_DIR}/mend.sock`;
const CHANNEL_CANARY_VALUE = "volume-e2e-canary";

const dockerMountSchema = z.strictObject({
  Type: z.literal("volume"),
  Source: z.string().min(1),
  Target: z.string().startsWith("/"),
  ReadOnly: z.boolean().default(false),
  Consistency: z.string().optional(),
  VolumeOptions: z.strictObject({
    NoCopy: z.boolean(),
    Subpath: z.string().min(1),
    Labels: z.record(z.string(), z.string()).optional(),
    DriverConfig: z.unknown().nullable().optional(),
  }),
});

const dockerMountsSchema = z.array(dockerMountSchema);
const phaseSchema = z.enum(["phase1", "phase2"]);

interface ExpectedMount {
  readonly target: string;
  readonly source: string;
  readonly subpath: string;
  readonly readOnly: boolean;
}

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required controller environment variable ${name}.`);
  }
  return value;
};

const docker = async (args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
};

const run = async (command: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
};

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const publishedImage = (image: string) => ({
  repository: "sealant/volume-mount-e2e-workspace",
  tag: "fixture",
  reference: image,
  digestReference: image,
  digest: "sha256:e2e-fixture",
});

const baseBlueprint = (
  workspace:
    | { readonly kind: "mount"; readonly hostPath: string }
    | {
        readonly kind: "standby";
        readonly rootPath: string;
      },
  mounts: ReadonlyArray<{
    readonly hostPath: string;
    readonly mountPath: string;
    readonly readOnly: boolean;
    readonly bindable?: boolean;
  }> = [],
) => ({
  version: "1",
  sources: { workspace, inputs: [], mounts },
  harness: { id: "codex" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: { packages: [] },
  customization: {
    defaultShell: "bash",
    dotfilesManager: "auto",
    dotfilesTarget: "home",
    applyDotfiles: true,
    dotfilesBootstrap: false,
  },
  lifecycle: {
    setup: [],
    startup: { steps: [], foreground: { kind: "command", run: "sleep infinity", shell: "sh" } },
  },
  runtime: {
    env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity", HOME: "/root" },
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace/repo",
    persistence: "ephemeral",
    ociRuntime: "runc",
    network: { outbound: true },
  },
  target: {
    runtime: { family: "docker", mode: "require" },
    os: { family: "fedora", mode: "prefer" },
  },
});

const targetFor = (result: RuntimeAdapterLaunchResult): SealantTarget => {
  const endpoint = result.endpoint;
  if (endpoint === undefined || !endpoint.startsWith("unix://")) {
    throw new Error(`Expected a unix control endpoint, received ${endpoint ?? "none"}.`);
  }
  return { kind: "unix-socket", socketPath: endpoint.slice("unix://".length) };
};

const execShell = async (target: SealantTarget, script: string): Promise<string> => {
  const result = await Effect.runPromise(
    execInWorkspace(target, { executable: "/bin/bash", args: ["-lc", script] }).pipe(
      Effect.provide(SealantRuntimeControlLive),
    ),
  );
  if (result.exitCode !== 0) {
    throw new Error(`Workspace command exited ${result.exitCode}: ${script}`);
  }
  return result.stdout;
};

const parseDockerJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Docker returned invalid JSON for ${description}.`, { cause });
  }
};

const inspectMounts = async (
  containerId: string,
): Promise<readonly z.infer<typeof dockerMountSchema>[]> => {
  const raw = await docker(["inspect", "--format", "{{json .HostConfig.Mounts}}", containerId]);
  return dockerMountsSchema.parse(parseDockerJson(raw, `mounts for ${containerId}`));
};

const assertVolumeMounts = async (
  containerId: string,
  expected: readonly ExpectedMount[],
): Promise<void> => {
  const mounts = await inspectMounts(containerId);
  assertCondition(
    mounts.length === expected.length,
    `Expected ${expected.length} volume mounts, received ${mounts.length}.`,
  );
  for (const wanted of expected) {
    const actual = mounts.find((mount) => mount.Target === wanted.target);
    assertCondition(actual !== undefined, `Missing volume mount at ${wanted.target}.`);
    if (actual === undefined) {
      continue;
    }
    assertCondition(actual.Source === wanted.source, `Wrong volume for ${wanted.target}.`);
    assertCondition(
      actual.ReadOnly === wanted.readOnly,
      `Wrong read-only mode for ${wanted.target}.`,
    );
    assertCondition(actual.VolumeOptions.NoCopy, `volume-nocopy missing for ${wanted.target}.`);
    assertCondition(
      actual.VolumeOptions.Subpath === wanted.subpath,
      `Wrong volume subpath for ${wanted.target}: ${actual.VolumeOptions.Subpath}.`,
    );
  }

  const binds = await docker(["inspect", "--format", "{{json .HostConfig.Binds}}", containerId]);
  assertCondition(
    binds === "null" || binds === "[]",
    `Workspace unexpectedly has bind mounts: ${binds}`,
  );
};

const launch = (
  adapter: DockerRuntimeAdapter,
  input: RuntimeAdapterLaunchInput,
): Promise<RuntimeAdapterLaunchResult> => adapter.launch(input);

const expectLaunchRejected = async (
  adapter: DockerRuntimeAdapter,
  input: RuntimeAdapterLaunchInput,
  label: string,
  expectedDiagnostic: RegExp,
): Promise<string> => {
  let result: RuntimeAdapterLaunchResult;
  try {
    result = await adapter.launch(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertCondition(
      expectedDiagnostic.test(message),
      `${label} failed for an unexpected reason: ${message}`,
    );
    return message;
  }
  await adapter.stop({ resourceId: result.resourceId, reference: result.reference });
  throw new Error(`${label} launch unexpectedly succeeded.`);
};

const createLaunchInput = (
  image: string,
  runId: string,
  blueprint: ReturnType<typeof baseBlueprint>,
  extras: {
    readonly dotfilesArchiveDir?: string;
    readonly secretEnvDir?: string;
    readonly binds?: ReadonlyArray<{ readonly mountPath: string; readonly subpath: string }>;
  } = {},
): RuntimeAdapterLaunchInput =>
  parseRuntimeAdapterLaunchInput({
    blueprint,
    publishedImage: publishedImage(image),
    runId,
    ...extras,
  });

const seedNamedVolumes = async (): Promise<void> => {
  await rm(`${STORE_ROOT}/project`, { recursive: true, force: true });
  await rm(`${STORE_ROOT}/escape`, { recursive: true, force: true });
  await Promise.all([
    rm(`${STAGING_ROOT}/dotfiles`, { recursive: true, force: true }),
    rm(`${STAGING_ROOT}/dotfiles-source`, { recursive: true, force: true }),
    rm(`${STAGING_ROOT}/secrets`, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(`${STORE_ROOT}/project/worktrees`, { recursive: true }),
    mkdir(REFERENCE_DIR, { recursive: true }),
    mkdir(HOME_DIR, { recursive: true }),
    mkdir(SESSION_DIR, { recursive: true }),
    mkdir(`${BINDABLE_ROOT}/selected`, { recursive: true }),
    mkdir(`${STANDBY_ROOT}/alpha`, { recursive: true }),
    mkdir(DOTFILES_DIR, { recursive: true }),
    mkdir(SECRET_ENV_DIR, { recursive: true, mode: 0o700 }),
  ]);

  await Promise.all([
    writeFile(`${REFERENCE_DIR}/value.txt`, "reference-read-only\n"),
    writeFile(`${BINDABLE_ROOT}/selected/value.txt`, "bindable-selected\n"),
    writeFile(`${STANDBY_ROOT}/alpha/value.txt`, "standby-selected\n"),
    writeFile(
      `${SECRET_ENV_DIR}/env.json`,
      JSON.stringify({ VOLUME_E2E_CHANNEL_CANARY: CHANNEL_CANARY_VALUE }),
      {
        mode: 0o600,
      },
    ),
  ]);

  const dotfilesSource = `${STAGING_ROOT}/dotfiles-source`;
  await mkdir(dotfilesSource, { recursive: true });
  await writeFile(`${dotfilesSource}/.sealant-volume-dotfile`, "dotfiles-applied\n");
  await run("tar", ["-czf", `${DOTFILES_DIR}/0.tar.gz`, "-C", dotfilesSource, "."]);
  await writeFile(
    `${DOTFILES_DIR}/manifest.json`,
    `${JSON.stringify({
      archives: [{ file: "0.tar.gz", manager: "copy", target: "home", bootstrap: false }],
    })}\n`,
  );

  const seedRepository = `${STORE_ROOT}/project/seed`;
  await mkdir(seedRepository, { recursive: true });
  await run("git", ["init", "-q", "--bare", COMMON_DIR]);
  await run("git", ["-C", seedRepository, "init", "-q"]);
  await run("git", ["-C", seedRepository, "config", "user.email", "volume-e2e@sealant.invalid"]);
  await run("git", ["-C", seedRepository, "config", "user.name", "Sealant volume E2E"]);
  await writeFile(`${seedRepository}/README.md`, "# volume-backed workspace\n");
  await run("git", ["-C", seedRepository, "add", "README.md"]);
  await run("git", ["-C", seedRepository, "commit", "-qm", "initial"]);
  await run("git", ["-C", seedRepository, "branch", "-M", "main"]);
  await run("git", ["-C", seedRepository, "push", "-q", COMMON_DIR, "main"]);
  await run("git", ["-C", COMMON_DIR, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await run("git", [
    "-C",
    COMMON_DIR,
    "worktree",
    "add",
    "-q",
    "-b",
    "mend/session/1",
    WORKTREE,
    "main",
  ]);
  await rm(seedRepository, { recursive: true, force: true });

  const gitPointer = (await readFile(`${WORKTREE}/.git`, "utf8")).trim();
  assertCondition(
    gitPointer === `gitdir: ${COMMON_DIR}/worktrees/session-1`,
    `Linked-worktree pointer is wrong: ${gitPointer}`,
  );

  await symlink("/outside-the-store", `${STORE_ROOT}/escape`);
  await symlink(`${STORE_ROOT}/project`, `${STORE_ROOT}/other-session-link`);
};

const openPersistentSession = async (target: SealantTarget): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        const opened = yield* session.openSession({
          shell: "/bin/bash",
          args: ["-lc", "sleep 300"],
          cols: 80,
          rows: 24,
        });
        return opened.sessionId;
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

const listSessions = async (target: SealantTarget): Promise<readonly string[]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        const sessions = yield* session.listSessions;
        return sessions.map((item) => item.sessionId);
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

const closeSession = async (target: SealantTarget, sessionId: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        yield* session.closeSession(sessionId);
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

const closeSessionServer = async (server: ReturnType<typeof createServer>): Promise<void> => {
  server.close();
  try {
    await once(server, "close");
  } catch {
    // The process is already tearing down; the named-volume socket path is removed below.
  }
};

const stopIgnoringFailure = async (
  adapter: DockerRuntimeAdapter,
  result: RuntimeAdapterLaunchResult,
): Promise<void> => {
  try {
    await adapter.stop({ resourceId: result.resourceId, reference: result.reference });
  } catch {
    // The host-side E2E finalizer removes the exact deterministic container name as a backstop.
  }
};

const main = async (): Promise<void> => {
  const phase = phaseSchema.parse(process.argv[2]);
  const image = requiredEnv("SEALANT_E2E_WORKSPACE_IMAGE");
  const containerPrefix = requiredEnv("SEALANT_E2E_CONTAINER_PREFIX");
  const volumeMappings = parseDockerVolumeMappings(requiredEnv("SEALANT_DOCKER_VOLUME_MAPPINGS"));
  const volumes = new Map(
    volumeMappings.map((mapping) => [mapping.logicalRoot, mapping.volumeName]),
  );
  const storeVolume = volumes.get(STORE_ROOT);
  const controlVolume = volumes.get(CONTROL_ROOT);
  const stagingVolume = volumes.get(STAGING_ROOT);
  if (storeVolume === undefined || controlVolume === undefined || stagingVolume === undefined) {
    throw new Error("Controller volume mappings do not cover store, control, and staging roots.");
  }

  const options: DockerRuntimeAdapterOptions = {
    containerNamePrefix: containerPrefix,
    autoRemove: false,
    controlSocketHostDir: CONTROL_ROOT,
    mountAllowedStoreRoots: STORE_ROOT,
    readinessTimeoutMs: 60_000,
    volumeMappings,
  };
  const adapter = new DockerRuntimeAdapter(options);
  const launched: RuntimeAdapterLaunchResult[] = [];

  try {
    if (phase === "phase1") {
      await seedNamedVolumes();
      await rm(SESSION_SOCKET, { force: true });
      let sessionRequest = "";
      let resolveSessionRequest: ((value: string) => void) | undefined;
      const receivedSessionRequest = new Promise<string>((resolve) => {
        resolveSessionRequest = resolve;
      });
      const sessionServer = createServer((socket) => {
        socket.once("data", (chunk) => {
          sessionRequest = chunk.toString("utf8");
          resolveSessionRequest?.(sessionRequest);
          socket.end("controller-reply\n");
        });
      });
      sessionServer.listen(SESSION_SOCKET);
      await once(sessionServer, "listening");

      try {
        const primaryInput = createLaunchInput(
          image,
          "primary",
          baseBlueprint({ kind: "mount", hostPath: WORKTREE }, [
            { hostPath: COMMON_DIR, mountPath: COMMON_DIR, readOnly: false },
            { hostPath: REFERENCE_DIR, mountPath: "/workspace/ref/lib", readOnly: true },
            { hostPath: HOME_DIR, mountPath: "/root", readOnly: false },
            { hostPath: SESSION_DIR, mountPath: "/run/mend", readOnly: true },
            {
              hostPath: BINDABLE_ROOT,
              mountPath: "/workspace/bindable",
              readOnly: false,
              bindable: true,
            },
          ]),
          {
            dotfilesArchiveDir: DOTFILES_DIR,
            secretEnvDir: SECRET_ENV_DIR,
            binds: [{ mountPath: "/workspace/bindable", subpath: "selected" }],
          },
        );
        const primary = await launch(adapter, primaryInput);
        launched.push(primary);
        const primaryTarget = targetFor(primary);

        await assertVolumeMounts(primary.resourceId, [
          {
            target: "/run/sealant",
            source: controlVolume,
            subpath: primary.reference,
            readOnly: false,
          },
          {
            target: "/run/sealant/dotfiles",
            source: stagingVolume,
            subpath: "dotfiles/primary",
            readOnly: true,
          },
          {
            target: "/run/sealant/secrets",
            source: stagingVolume,
            subpath: "secrets/primary",
            readOnly: true,
          },
          {
            target: "/workspace/repo",
            source: storeVolume,
            subpath: "project/worktrees/session-1",
            readOnly: false,
          },
          {
            target: COMMON_DIR,
            source: storeVolume,
            subpath: "project/repo.git",
            readOnly: false,
          },
          {
            target: "/workspace/ref/lib",
            source: storeVolume,
            subpath: "_references/lib",
            readOnly: true,
          },
          { target: "/root", source: storeVolume, subpath: "harness-home", readOnly: false },
          {
            target: "/run/mend",
            source: storeVolume,
            subpath: "_run/sessions/1",
            readOnly: true,
          },
          {
            target: bindRootMountPath("/workspace/bindable"),
            source: storeVolume,
            subpath: "bindable",
            readOnly: false,
          },
        ]);

        const primaryProof = await execShell(
          primaryTarget,
          [
            `test "$(git rev-parse --git-common-dir)" = "${COMMON_DIR}"`,
            'test "$(git rev-parse --show-toplevel)" = "/workspace/repo"',
            `test ! -e ${STANDBY_ROOT}/alpha/value.txt`,
            `test ! -e ${CONTROL_ROOT}`,
            'test "$(cat /workspace/ref/lib/value.txt)" = "reference-read-only"',
            "if printf blocked > /workspace/ref/lib/blocked.txt 2>/dev/null; then exit 31; fi",
            'test "$(cat "$HOME/.sealant-volume-dotfile")" = "dotfiles-applied"',
            'test "$VOLUME_E2E_CHANNEL_CANARY" = "volume-e2e-canary"',
            'test "$(cat /workspace/bindable/value.txt)" = "bindable-selected"',
            'printf "persisted-home\\n" > "$HOME/persisted.txt"',
            'printf "persisted-bindable\\n" > /workspace/bindable/persisted.txt',
            'printf "from-workspace\\n" > from-workspace.txt',
            "git config user.email volume-e2e@sealant.invalid",
            'git config user.name "Sealant volume E2E"',
            "git add from-workspace.txt",
            'git commit -qm "workspace volume commit"',
            'printf "session-request\\n" | socat - UNIX-CONNECT:/run/mend/mend.sock',
          ].join(" && "),
        );
        assertCondition(
          primaryProof === "controller-reply\n",
          "Session socket reply was not received.",
        );
        const request = await Promise.race([
          receivedSessionRequest,
          new Promise<string>((_, reject) =>
            setTimeout(
              () => reject(new Error("Controller did not receive the session socket request.")),
              5_000,
            ),
          ),
        ]);
        assertCondition(
          request === "session-request\n",
          `Wrong session socket request: ${request}`,
        );

        const standbyInput = createLaunchInput(
          image,
          "standby",
          baseBlueprint({ kind: "standby", rootPath: STANDBY_ROOT }),
          { binds: [{ mountPath: "/workspace/repo", subpath: "alpha" }] },
        );
        const standby = await launch(adapter, standbyInput);
        launched.push(standby);
        const standbyTarget = targetFor(standby);
        await assertVolumeMounts(standby.resourceId, [
          {
            target: "/run/sealant",
            source: controlVolume,
            subpath: standby.reference,
            readOnly: false,
          },
          {
            target: "/workspace/.roots/workspace",
            source: storeVolume,
            subpath: "standby",
            readOnly: false,
          },
        ]);
        const standbyValue = await execShell(
          standbyTarget,
          `test ! -e ${WORKTREE} && test ! -e /run/mend && test ! -e ${CONTROL_ROOT} && cat /workspace/repo/value.txt`,
        );
        assertCondition(
          standbyValue === "standby-selected\n",
          "Standby bind selected the wrong data.",
        );

        const primarySession = await openPersistentSession(primaryTarget);
        const primarySessions = await listSessions(primaryTarget);
        const standbySessions = await listSessions(standbyTarget);
        assertCondition(
          primarySessions.includes(primarySession),
          "Primary session was not listed.",
        );
        assertCondition(
          standbySessions.length === 0,
          "A sibling workspace could see the primary session.",
        );
        await closeSession(primaryTarget, primarySession);

        const missingInput = createLaunchInput(
          image,
          "missing",
          baseBlueprint({ kind: "mount", hostPath: `${STORE_ROOT}/missing/worktree` }),
        );
        const missingMessage = await expectLaunchRejected(
          adapter,
          missingInput,
          "missing subpath",
          /does not exist/,
        );

        const escapeInput = createLaunchInput(
          image,
          "escape",
          baseBlueprint({ kind: "mount", hostPath: `${STORE_ROOT}/escape/worktree` }),
        );
        const escapeMessage = await expectLaunchRejected(
          adapter,
          escapeInput,
          "symlink escape",
          /must not be a symbolic link/,
        );
        // Docker confines subpaths to the volume root, not to one session. The adapter must
        // also reject an alias to a different directory inside that same volume.
        await expectLaunchRejected(
          adapter,
          createLaunchInput(
            image,
            "internal-alias",
            baseBlueprint({
              kind: "mount",
              hostPath: `${STORE_ROOT}/other-session-link/worktrees/session-1`,
            }),
          ),
          "same-volume source alias",
          /must not be a symbolic link/,
        );

        for (const result of launched.toReversed()) {
          const stopped = await adapter.stop({
            resourceId: result.resourceId,
            reference: result.reference,
          });
          assertCondition(stopped.outcome === "stopped", `Failed to stop ${result.reference}.`);
          launched.splice(launched.indexOf(result), 1);
        }

        const persisted = await Promise.all([
          readFile(`${WORKTREE}/from-workspace.txt`, "utf8"),
          readFile(`${HOME_DIR}/persisted.txt`, "utf8"),
          readFile(`${BINDABLE_ROOT}/selected/persisted.txt`, "utf8"),
        ]);
        assertCondition(
          persisted.join("") === "from-workspace\npersisted-home\npersisted-bindable\n",
          "Named-volume data did not persist after workspace stop.",
        );
        await writeFile(`${STORE_ROOT}/phase1-complete`, "controller-replacement-ready\n");

        process.stdout.write(
          `SEALANT_VOLUME_E2E_RESULT=${JSON.stringify({
            phase,
            controller: hostname(),
            platform: process.platform,
            primary: primary.reference,
            standby: standby.reference,
            volumeMountCount: 11,
            gitCommit: "workspace volume commit",
            sessionSocket: "controller-reply",
            siblingSessionCount: standbySessions.length,
            missingSubpathRejected: missingMessage.length > 0,
            symlinkEscapeRejected: escapeMessage.length > 0,
          })}\n`,
        );
      } finally {
        await closeSessionServer(sessionServer);
        await rm(SESSION_SOCKET, { force: true });
      }
    } else {
      const phaseMarker = await readFile(`${STORE_ROOT}/phase1-complete`, "utf8");
      assertCondition(
        phaseMarker === "controller-replacement-ready\n",
        "Replacement controller did not see phase-one state.",
      );
      // Reuse the same deterministic run name and retained control directory after the first
      // controller exits. A stale socket entry must not prevent the new daemon from becoming ready.
      const replacementInput = createLaunchInput(
        image,
        "primary",
        baseBlueprint({ kind: "mount", hostPath: WORKTREE }, [
          { hostPath: COMMON_DIR, mountPath: COMMON_DIR, readOnly: false },
          { hostPath: HOME_DIR, mountPath: "/root", readOnly: false },
          {
            hostPath: BINDABLE_ROOT,
            mountPath: "/workspace/bindable",
            readOnly: false,
            bindable: true,
          },
        ]),
        { binds: [{ mountPath: "/workspace/bindable", subpath: "selected" }] },
      );
      const replacement = await launch(adapter, replacementInput);
      launched.push(replacement);
      const target = targetFor(replacement);
      const proof = await execShell(
        target,
        [
          'test "$(cat from-workspace.txt)" = "from-workspace"',
          'test "$(cat "$HOME/persisted.txt")" = "persisted-home"',
          'test "$(cat /workspace/bindable/persisted.txt)" = "persisted-bindable"',
          "git log -1 --format=%s",
        ].join(" && "),
      );
      assertCondition(
        proof === "workspace volume commit\n",
        `Replacement workspace saw the wrong Git state: ${proof}`,
      );
      const stopped = await adapter.stop({
        resourceId: replacement.resourceId,
        reference: replacement.reference,
      });
      assertCondition(stopped.outcome === "stopped", "Replacement workspace did not stop.");
      launched.pop();

      process.stdout.write(
        `SEALANT_VOLUME_E2E_RESULT=${JSON.stringify({
          phase,
          controller: hostname(),
          platform: process.platform,
          replacement: replacement.reference,
          persistedGitCommit: proof.trim(),
          persistedHome: true,
          persistedBindable: true,
        })}\n`,
      );
    }
  } finally {
    for (const result of launched.toReversed()) {
      await stopIgnoringFailure(adapter, result);
    }
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
