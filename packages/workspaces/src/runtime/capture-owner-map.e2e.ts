/**
 * The capture owner map through Core's Docker adapter and a real daemon, on a per-person image
 * (Mend's ADR 0016 decisions 1, 2 and 8; sealantd#145 and #148):
 *
 * 1. **Without a map, as today.** An executor launched with no owner map seeds a worktree and a
 *    person's saved directory, and boots with no-new-privileges: `runtime.getCapabilities` says so,
 *    and a person's `sudo`, run under the daemon, is refused. Its restore into a second executor
 *    with no map gives everything back to root at the recorded modes.
 * 2. **With a map.** The same capture restored into an executor launched with an owner map: the
 *    daemon boots without no-new-privileges (`noNewPrivileges: false`), a person's `sudo -n true`
 *    under the daemon works, the worktree root is the change owner's and the group's (setgid), its
 *    files group-writable, the person's saved directory theirs (0710), their own transcript 0600
 *    and their shared conversation group-writable.
 *
 * The image must be a managed per-person image whose sealantd reports `restore.owner_map` (the
 * pinned 0.20.0-next.150 or later): `SEALANT_OWNER_MAP_E2E_IMAGE`, default
 * `sealant-workspace-fedora:latest`. Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/runtime/capture-owner-map.e2e.ts
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { parseWorkspaceImageProbe } from "@sealant/validators";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { imageAppliesOwnerMap } from "../buildkit/person-layout.js";
import { assertImageRequirement, docker, isImagePresent } from "../sealantd/boot.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantSession,
} from "../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import { startCaptureChannel, type CaptureChannel } from "./capture-channel.fixture.js";
import {
  DockerRuntimeAdapter,
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchInput,
} from "./index.js";

const IMAGE_REF = process.env["SEALANT_OWNER_MAP_E2E_IMAGE"] ?? "sealant-workspace-fedora:latest";
const CAPTURE_TOKEN = "capture-owner-map-e2e-token";
const WORKTREE_ID = "capture-owner-map-e2e-worktree";
const HARNESS_HOME = "/workspace/harness-home";
const REPO = "/workspace/repo";
const PERSON_DIR = `${HARNESS_HOME}/people/acct_a`;
const TRANSCRIPT = `${PERSON_DIR}/.claude/projects/p/t.jsonl`;
const CONVERSATION = `${PERSON_DIR}/conversations/s1/projects/p/c.jsonl`;
const OWNER_UID = 40012;
const OTHER_UID = 40031;
const MEND_GID = 40000;
const OWNER_MAP = {
  gid: MEND_GID,
  worktreeUid: OWNER_UID,
  people: [
    { id: "acct_a", uid: OWNER_UID },
    { id: "acct_b", uid: OTHER_UID },
  ],
};

const launchInput = (input: {
  readonly endpoint: string;
  readonly secretEnvDir: string;
  readonly ownerMap?: typeof OWNER_MAP;
}): RuntimeAdapterLaunchInput =>
  parseRuntimeAdapterLaunchInput({
    blueprint: {
      version: "1",
      sources: {
        workspace: {
          kind: "capture",
          endpoint: input.endpoint,
          worktreeId: WORKTREE_ID,
          harnessHome: HARNESS_HOME,
          ...(input.ownerMap === undefined ? {} : { ownerMap: input.ownerMap }),
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
    runId: `owner-map-e2e-${randomUUID()}`,
    secretEnvDir: input.secretEnvDir,
    secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
  });

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

/** What the daemon reports of its own privilege posture (`runtime.getCapabilities`). */
const noNewPrivileges = (containerId: string) =>
  withDaemon(containerId, (session) => session.capabilities).then(
    (capabilities) => capabilities.noNewPrivileges,
  );

/**
 * Runs `script` as a process the daemon starts (so it inherits the daemon's no-new-privileges, as
 * every person's process does), answering its exit code and stdout. `docker exec` would not do:
 * its processes are the container runtime's, not the daemon's.
 */
const execUnderDaemon = (containerId: string, script: string) =>
  withDaemon(containerId, (session) =>
    Effect.gen(function* () {
      const accepted = yield* session.exec({
        executable: "/bin/sh",
        args: ["-c", script],
        stdin: false,
      });
      const events = yield* session.events.pipe(
        Stream.filter(
          (event: EventEnvelope) =>
            event.processId === undefined || event.processId === accepted.processId,
        ),
        Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
        Stream.runCollect,
      );
      let stdout = "";
      let exitCode: number | undefined;
      for (const event of events) {
        const payload = event.payload;
        if (
          payload.case === "ioChunk" &&
          payload.value.stream === StreamKind.STDOUT &&
          payload.value.content !== undefined
        ) {
          stdout += Buffer.from(payload.value.content).toString("utf8");
        } else if (payload.case === "processExited") {
          exitCode = payload.value.exitCode;
        }
      }
      return { exitCode, stdout };
    }),
  );

/** A person's `sudo -n true`, as their uid, under the daemon. */
const personSudo = async (containerId: string) => {
  // Users are made at prepare, as root (Mend does it through the platform's exec).
  await docker([
    "exec",
    containerId,
    "sh",
    "-c",
    `getent passwd ${OWNER_UID} >/dev/null || useradd -u ${OWNER_UID} -g mend -M -d /tmp -s /bin/sh mowner`,
  ]);
  return execUnderDaemon(
    containerId,
    `setpriv --reuid=${OWNER_UID} --regid=${MEND_GID} --init-groups -- sudo -n true && echo SUDO_OK || echo SUDO_REFUSED; grep NoNewPrivs /proc/self/status`,
  );
};

/** `uid:gid:mode` (octal, setgid included) of each path, inside the executor. */
const owners = async (containerId: string, paths: readonly string[]) => {
  const out = await docker(["exec", containerId, "stat", "-c", "%n %u:%g:%a", ...paths]);
  return Object.fromEntries(
    out.split("\n").map((line) => {
      const [path = "", rest = ""] = line.split(" ");
      return [path, rest];
    }),
  );
};

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

/** What the image's own probe recorded: only an image whose sealantd applies a map is tested. */
const readImageProbe = async () => {
  const recorded = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    IMAGE_REF,
    "/etc/sealant/image-probe.json",
  ]).catch(() => undefined);
  return recorded === undefined ? undefined : parseWorkspaceImageProbe(JSON.parse(recorded));
};

const imageTakesOwnerMap = imageAvailable && imageAppliesOwnerMap(await readImageProbe()) === "yes";
if (imageAvailable && !imageTakesOwnerMap && process.env["SEALANT_E2E_REQUIRE_IMAGE"] === "1") {
  throw new Error(
    `SEALANT_E2E_REQUIRE_IMAGE=1 but ${IMAGE_REF}'s probe does not report restore.owner_map: build a managed image with the pinned sealantd.`,
  );
}

const containers = new Set<string>();
const temporaryDirectories = new Set<string>();
let channel: CaptureChannel | undefined;
let secretEnvDir = "";

const adapter = new DockerRuntimeAdapter({
  autoRemove: false,
  containerNamePrefix: "sealant-owner-map-e2e",
  runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
  workspaceNetwork: "host",
});

const launch = async (ownerMap?: typeof OWNER_MAP) => {
  if (channel === undefined) throw new Error("the capture channel is not up");
  const launched = await adapter.launch(
    launchInput({
      endpoint: channel.endpoint,
      secretEnvDir,
      ...(ownerMap === undefined ? {} : { ownerMap }),
    }),
  );
  containers.add(launched.resourceId);
  return launched.resourceId;
};

const remove = async (containerId: string) => {
  await docker(["rm", "-f", containerId]);
  containers.delete(containerId);
};

beforeAll(async () => {
  if (!imageTakesOwnerMap) return;
  channel = await startCaptureChannel({ token: CAPTURE_TOKEN, worktreeId: WORKTREE_ID });
  secretEnvDir = await mkdtemp(join(tmpdir(), "sealant-owner-map-secrets-"));
  temporaryDirectories.add(secretEnvDir);
  await chmod(secretEnvDir, 0o700);
  await writeFile(
    join(secretEnvDir, "env.json"),
    JSON.stringify({ SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN }),
    { mode: 0o600 },
  );
});

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

describe.skipIf(!imageTakesOwnerMap)(
  "a capture executor's owner map, on a per-person image",
  () => {
    it("without a map: no-new-privileges set, a person's sudo refused, the capture seeded", async () => {
      const seed = await launch();
      expect(await noNewPrivileges(seed)).toBe(true);
      const sudo = await personSudo(seed);
      expect(sudo.stdout).toContain("SUDO_REFUSED");
      expect(sudo.stdout).toMatch(/NoNewPrivs:\s*1/);

      // Written as root with umask 022, as every capture before the per-person layout was.
      await docker([
        "exec",
        seed,
        "sh",
        "-c",
        [
          "umask 022",
          `mkdir -p ${REPO}/src ${PERSON_DIR}/.claude/projects/p ${PERSON_DIR}/conversations/s1/projects/p`,
          `echo 'export const a = 1;' > ${REPO}/src/a.ts`,
          `echo '{"own":1}' > ${TRANSCRIPT} && chmod 0600 ${TRANSCRIPT}`,
          `echo '{"shared":1}' > ${CONVERSATION} && chmod 0600 ${CONVERSATION}`,
        ].join(" && "),
      ]);
      const flush = await withDaemon(seed, (session) => session.captureFlush());
      expect(flush.fenced).toBe(false);
      expect(flush.pending).toBe(0);
      expect(channel?.state.head).toBeDefined();
      await remove(seed);
    }, 240_000);

    it("without a map: the restore is root's at the recorded modes, as today", async () => {
      const plain = await launch();
      expect(await noNewPrivileges(plain)).toBe(true);
      const found = await owners(plain, [REPO, `${REPO}/src/a.ts`, PERSON_DIR, TRANSCRIPT]);
      expect(found[REPO]?.startsWith("0:0:")).toBe(true);
      expect(found[`${REPO}/src/a.ts`]).toBe("0:0:644");
      expect(found[PERSON_DIR]?.startsWith("0:0:")).toBe(true);
      expect(found[TRANSCRIPT]).toBe("0:0:600");
      await remove(plain);
    }, 240_000);

    it("with a map: no-new-privileges unset, a person's sudo works, each file its owner's", async () => {
      const person = await launch(OWNER_MAP);
      expect(await noNewPrivileges(person)).toBe(false);
      const sudo = await personSudo(person);
      expect(sudo.stdout).toContain("SUDO_OK");
      expect(sudo.stdout).toMatch(/NoNewPrivs:\s*0/);

      const env = await docker([
        "inspect",
        person,
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
      ]);
      expect(env.split("\n")).toContain(
        `SEALANT_CAPTURE_OWNER_MAP={"gid":40000,"worktree":${OWNER_UID},"people":{"acct_a":${OWNER_UID},"acct_b":${OTHER_UID}}}`,
      );

      const found = await owners(person, [
        REPO,
        `${REPO}/src`,
        `${REPO}/src/a.ts`,
        PERSON_DIR,
        TRANSCRIPT,
        CONVERSATION,
      ]);
      // The worktree root: the change owner's and the group's, setgid; its entries the group's.
      expect(found[REPO]).toBe(`${OWNER_UID}:${MEND_GID}:2775`);
      expect(found[`${REPO}/src`]).toMatch(new RegExp(`^\\d+:${MEND_GID}:2775$`));
      expect(found[`${REPO}/src/a.ts`]).toMatch(new RegExp(`^\\d+:${MEND_GID}:664$`));
      // The person's saved directory: theirs, the group passes through only.
      expect(found[PERSON_DIR]).toBe(`${OWNER_UID}:${MEND_GID}:710`);
      expect(found[TRANSCRIPT]).toBe(`${OWNER_UID}:${MEND_GID}:600`);
      expect(found[CONVERSATION]).toBe(`${OWNER_UID}:${MEND_GID}:660`);

      // A second person can edit the worktree the owner's restore handed to the group.
      await docker([
        "exec",
        person,
        "sh",
        "-c",
        `getent passwd ${OTHER_UID} >/dev/null || useradd -u ${OTHER_UID} -g mend -M -d /tmp -s /bin/sh mother`,
      ]);
      const edit = await execUnderDaemon(
        person,
        `setpriv --reuid=${OTHER_UID} --regid=${MEND_GID} --init-groups -- sh -c 'echo "// b" >> ${REPO}/src/a.ts && touch ${REPO}/src/b.ts' && echo EDIT_OK`,
      );
      expect(edit.stdout).toContain("EDIT_OK");
      expect(channel?.state.errors).toEqual([]);
    }, 240_000);
  },
);
