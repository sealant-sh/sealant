/**
 * A process started as a person's Linux user, through Core's check, Core's control client and a
 * real daemon, on a per-person image launched with an owner map (Mend's ADR 0016 decision 1;
 * sealantd#147 and #148):
 *
 * 1. **The check** (`liveProcessUserChannel`): the daemon reports `exec.user`; a person in the
 *    range whose primary group is `mend` passes, by name or uid; an image user outside the range, a
 *    user whose primary group is not `mend`, and an unknown user are each refused with their reason.
 * 2. **An exec as the person** (`ExecArgs.user`): it runs with their uid, the `mend` group and their
 *    `HOME`, writes files owned by them, cannot read another person's 0700 home, and `sudo -n true`
 *    works (the owner map left no-new-privileges unset).
 * 3. **A session as the person** (`OpenSessionArgs.user`): the PTY's leader is theirs.
 * 4. **A workspace whose sealantd has no `exec.user`** (the image with sealantd 0.19.0 copied over
 *    its own): the check answers unsupported and runs nothing, so Core refuses with that reason.
 *
 * The image must be a managed per-person image whose sealantd reports `exec.user` (the pinned
 * 0.20.0-next.150 or later): `SEALANT_PROCESS_USER_E2E_IMAGE`, default
 * `sealant-workspace-fedora:latest`. Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/runtime/process-user.e2e.ts
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertImageRequirement, docker, isImagePresent } from "../sealantd/boot.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantSession,
} from "../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import { startCaptureChannel, type CaptureChannel } from "./capture-channel.fixture.js";
import { DockerRuntimeAdapter, parseRuntimeAdapterLaunchInput } from "./index.js";
import {
  liveProcessUserChannel,
  PROCESS_USER_CHECK_EXIT,
  processUserCheckOutcome,
} from "./process-user.js";

const IMAGE_REF =
  process.env["SEALANT_PROCESS_USER_E2E_IMAGE"] ?? "sealant-workspace-fedora:latest";
/** A sealantd from before `exec.user` (0.20.0-next.150), copied over the image's own. */
const OLD_SEALANTD = "ghcr.io/sealant-sh/sealantd:0.19.0";
const OLD_IMAGE = "sealant-process-user-e2e-old-sealantd:local";
const CAPTURE_TOKEN = "process-user-e2e-token";
const WORKTREE_ID = "process-user-e2e-worktree";
const REPO = "/workspace/repo";
const MEND_GID = 40000;
const ALICE = { name: "m4lice000", uid: 40001, home: "/home/m4lice000" };
const BOB = { name: "m8ob0000", uid: 40002, home: "/home/m8ob0000" };
const OWNER_MAP = {
  gid: MEND_GID,
  worktreeUid: ALICE.uid,
  people: [
    { id: "acct_alice", uid: ALICE.uid },
    { id: "acct_bob", uid: BOB.uid },
  ],
};

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

/** What the image's sealantd says it supports, without booting it. */
const imageSupports = async (image: string): Promise<readonly string[]> => {
  const out = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "sealantd",
    image,
    "capabilities",
    "--json",
  ]).catch(() => undefined);
  if (out === undefined) return [];
  const parsed: unknown = JSON.parse(out);
  return typeof parsed === "object" &&
    parsed !== null &&
    "supports" in parsed &&
    Array.isArray(parsed.supports)
    ? parsed.supports.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const runsAsUser = imageAvailable && (await imageSupports(IMAGE_REF)).includes("exec.user");
if (imageAvailable && !runsAsUser && process.env["SEALANT_E2E_REQUIRE_IMAGE"] === "1") {
  throw new Error(
    `SEALANT_E2E_REQUIRE_IMAGE=1 but ${IMAGE_REF}'s sealantd does not report exec.user: build a managed image with the pinned sealantd.`,
  );
}

const withDaemon = <A, E>(
  containerId: string,
  use: (session: SealantSession) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(sealantTargetForDockerContainer(containerId));
        return yield* use(session);
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

/** The output (stdout, or a PTY's output) of one process and its exit, read from the events. */
const collect = (session: SealantSession, processId: string) =>
  Effect.gen(function* () {
    const events = yield* session.events.pipe(
      Stream.filter((event: EventEnvelope) => event.processId === processId),
      Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
      Stream.runCollect,
    );
    let output = "";
    let exitCode: number | undefined;
    for (const event of events) {
      const payload = event.payload;
      if (
        payload.case === "ioChunk" &&
        (payload.value.stream === StreamKind.STDOUT ||
          payload.value.stream === StreamKind.PTY_OUTPUT) &&
        payload.value.content !== undefined
      ) {
        output += Buffer.from(payload.value.content).toString("utf8");
      } else if (payload.case === "processExited") {
        exitCode = payload.value.exitCode;
      }
    }
    return { output, exitCode };
  });

/** `script` run by the daemon as `user` (an exec), answering its stdout and exit code. */
const execAs = (containerId: string, user: string, script: string) =>
  withDaemon(containerId, (session) =>
    Effect.gen(function* () {
      const accepted = yield* session.exec({
        executable: "/bin/sh",
        args: ["-c", script],
        cwd: REPO,
        stdin: false,
        user,
      });
      return yield* collect(session, accepted.processId);
    }),
  );

const sh = (containerId: string, script: string) =>
  docker(["exec", containerId, "sh", "-c", script]);

/** `docker build -t tag -` with the Dockerfile on stdin. */
const buildFromStdin = (tag: string, dockerfile: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["build", "-q", "-t", tag, "-"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`docker build ${tag} exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(dockerfile);
  });

const containers = new Set<string>();
const temporaryDirectories = new Set<string>();
let channel: CaptureChannel | undefined;
let personContainer = "";

const adapter = new DockerRuntimeAdapter({
  autoRemove: false,
  containerNamePrefix: "sealant-process-user-e2e",
  runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
  workspaceNetwork: "host",
});

/** A capture-sourced executor under the owner map, as Mend launches a person layout. */
const launchWithOwnerMap = async () => {
  if (channel === undefined) throw new Error("the capture channel is not up");
  const secretEnvDir = await mkdtemp(join(tmpdir(), "sealant-process-user-secrets-"));
  temporaryDirectories.add(secretEnvDir);
  await chmod(secretEnvDir, 0o700);
  await writeFile(
    join(secretEnvDir, "env.json"),
    JSON.stringify({ SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN }),
    { mode: 0o600 },
  );
  const launched = await adapter.launch(
    parseRuntimeAdapterLaunchInput({
      blueprint: {
        version: "1",
        sources: {
          workspace: {
            kind: "capture",
            endpoint: channel.endpoint,
            worktreeId: WORKTREE_ID,
            harnessHome: "/workspace/harness-home",
            ownerMap: OWNER_MAP,
          },
          inputs: [],
          mounts: [],
        },
        harness: { id: "opencode" },
        lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
        runtime: {
          env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
          network: { outbound: true },
        },
        target: { os: { family: "fedora" }, runtime: { family: "docker" } },
      },
      publishedImage: {
        repository: "sealant-workspace-fedora",
        tag: "latest",
        reference: IMAGE_REF,
        digestReference: IMAGE_REF,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      runId: `process-user-e2e-${randomUUID()}`,
      secretEnvDir,
      secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
    }),
  );
  containers.add(launched.resourceId);
  return launched.resourceId;
};

/** A plain mount-sourced executor of `image` (no owner map). */
const launchPlain = async (image: string) => {
  const storeRoot = await mkdtemp(join(tmpdir(), "sealant-process-user-e2e-"));
  temporaryDirectories.add(storeRoot);
  const worktree = join(storeRoot, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "README.md"), "process user e2e\n");
  const plain = new DockerRuntimeAdapter({
    autoRemove: false,
    containerNamePrefix: "sealant-process-user-e2e-old",
    runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
    mountAllowedStoreRoots: storeRoot,
  });
  const launched = await plain.launch(
    parseRuntimeAdapterLaunchInput({
      blueprint: {
        version: "1",
        sources: { workspace: { kind: "mount", hostPath: worktree }, inputs: [], mounts: [] },
        harness: { id: "opencode" },
        lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
        runtime: {
          env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
          network: { outbound: true },
        },
        target: { os: { family: "fedora" }, runtime: { family: "docker" } },
      },
      publishedImage: {
        repository: "sealant-workspace-fedora",
        tag: "latest",
        reference: image,
        digestReference: image,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      runId: `process-user-e2e-old-${randomUUID()}`,
    }),
  );
  containers.add(launched.resourceId);
  return launched.resourceId;
};

beforeAll(async () => {
  if (!runsAsUser) return;
  channel = await startCaptureChannel({ token: CAPTURE_TOKEN, worktreeId: WORKTREE_ID });
  personContainer = await launchWithOwnerMap();
  // Users are made at prepare, as root, through the platform's exec (Mend's ADR 0016): homes
  // 0700, primary group mend. One image user outside the range and one outside the group too.
  await sh(
    personContainer,
    [
      ...[ALICE, BOB].map(
        (person) =>
          `useradd -u ${String(person.uid)} -g mend -m -d ${person.home} -s /bin/sh ${person.name} && chmod 0700 ${person.home}`,
      ),
      `echo bob-only > ${BOB.home}/secret && chown ${BOB.name}:mend ${BOB.home}/secret && chmod 0600 ${BOB.home}/secret`,
      "useradd -u 1500 -m -s /bin/sh builder",
      "groupadd -g 41000 other && useradd -u 40003 -g other -M -s /bin/sh m0ther000",
    ].join(" && "),
  );
}, 240_000);

afterAll(async () => {
  await Promise.all(
    Array.from(containers, (containerId) =>
      docker(["rm", "-f", containerId]).catch(() => undefined),
    ),
  );
  if (channel !== undefined) await channel.close();
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!runsAsUser)("a process as a person, on a per-person image", () => {
  const check = (user: string) =>
    Effect.runPromise(
      liveProcessUserChannel.check(sealantTargetForDockerContainer(personContainer), user),
    );

  it("passes a person in the range by name or uid, and refuses the rest with their reason", async () => {
    expect(await check(ALICE.name)).toEqual({ supported: true, exitCode: 0 });
    expect(await check(String(BOB.uid))).toEqual({ supported: true, exitCode: 0 });
    const builder = await check("builder");
    expect(builder.exitCode).toBe(PROCESS_USER_CHECK_EXIT.uidOutOfRange);
    expect(processUserCheckOutcome(builder)).toMatchObject({ reason: "not-in-range" });
    const other = await check("m0ther000");
    expect(other.exitCode).toBe(PROCESS_USER_CHECK_EXIT.groupNotMend);
    expect(processUserCheckOutcome(other)).toMatchObject({ reason: "not-in-range" });
    const unknown = await check("mnobody00");
    expect(processUserCheckOutcome(unknown)).toMatchObject({ reason: "unknown-user" });
  }, 60_000);

  it("runs an exec as the person: their uid, the mend group, their home, files theirs", async () => {
    const ran = await execAs(
      personContainer,
      ALICE.name,
      [
        `printf 'uid=%s gid=%s groups=%s home=%s user=%s\\n' "$(id -u)" "$(id -g)" "$(id -Gn)" "$HOME" "$USER"`,
        `echo hi > ${REPO}/alice.txt && stat -c 'file=%U:%G' ${REPO}/alice.txt`,
        `echo mine > "$HOME/mine.txt" && stat -c 'home=%U:%a' "$HOME"`,
      ].join(" && "),
    );
    expect(ran.exitCode).toBe(0);
    expect(ran.output).toContain(`uid=${String(ALICE.uid)} gid=${String(MEND_GID)}`);
    expect(ran.output).toMatch(/groups=\S*mend/);
    expect(ran.output).toContain(`home=${ALICE.home} user=${ALICE.name}`);
    expect(ran.output).toContain(`file=${ALICE.name}:mend`);
    expect(ran.output).toContain(`home=${ALICE.name}:700`);
    // What the daemon wrote is the person's, seen from outside.
    expect((await sh(personContainer, `stat -c %u ${REPO}/alice.txt`)).trim()).toBe(
      String(ALICE.uid),
    );
  }, 60_000);

  it("cannot read another person's 0700 home", async () => {
    const ran = await execAs(
      personContainer,
      ALICE.name,
      `cat ${BOB.home}/secret && echo READ || echo REFUSED; ls ${BOB.home} >/dev/null 2>&1 && echo LISTED || echo NOT_LISTED`,
    );
    expect(ran.output).toContain("REFUSED");
    expect(ran.output).not.toContain("READ\n");
    expect(ran.output).not.toContain("bob-only");
    expect(ran.output).toContain("NOT_LISTED");
  }, 60_000);

  it("has a working sudo, since the owner map left no-new-privileges unset", async () => {
    const capabilities = await withDaemon(personContainer, (session) => session.capabilities);
    expect(capabilities.noNewPrivileges).toBe(false);
    const ran = await execAs(
      personContainer,
      ALICE.name,
      "sudo -n true && echo SUDO_OK || echo SUDO_REFUSED; grep NoNewPrivs /proc/self/status",
    );
    expect(ran.output).toContain("SUDO_OK");
    expect(ran.output).toMatch(/NoNewPrivs:\s*0/);
  }, 60_000);

  it("runs a session (PTY) as the person", async () => {
    const ran = await withDaemon(personContainer, (session) =>
      Effect.gen(function* () {
        const opened = yield* session.openSession({
          shell: "/bin/sh",
          args: ["-c", 'printf "pty uid=%s home=%s tty=%s\\n" "$(id -u)" "$HOME" "$(tty)"'],
          cwd: REPO,
          cols: 80,
          rows: 24,
          mode: "pty",
          user: BOB.name,
        });
        return yield* collect(session, opened.processId);
      }),
    );
    expect(ran.output).toContain(`pty uid=${String(BOB.uid)} home=${BOB.home} tty=/dev/pts/`);
    expect(ran.exitCode).toBe(0);
  }, 60_000);

  it("refuses on a workspace whose sealantd does not report exec.user, running nothing", async () => {
    await buildFromStdin(
      OLD_IMAGE,
      [
        `FROM ${IMAGE_REF}`,
        `COPY --from=${OLD_SEALANTD} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
      ].join("\n"),
    );
    expect(await imageSupports(OLD_IMAGE)).toEqual([]);
    const old = await launchPlain(OLD_IMAGE);
    const answer = await Effect.runPromise(
      liveProcessUserChannel.check(sealantTargetForDockerContainer(old), "m4lice000"),
    );
    expect(answer).toEqual({ supported: false, exitCode: undefined });
    expect(processUserCheckOutcome(answer)).toEqual({
      reason: "sealantd-unsupported",
      detail: "its sealantd does not report exec.user",
    });
  }, 240_000);
});
