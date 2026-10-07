import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  assertImageRequirement,
  DEFAULT_IMAGE_REF,
  docker,
  isImagePresent,
} from "../sealantd/boot.js";
import { SealantRuntime, SealantRuntimeControlLive } from "../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import { startCaptureChannel, type CaptureChannel } from "./capture-channel.fixture.js";
import {
  DockerRuntimeAdapter,
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchInput,
} from "./index.js";

const IMAGE_REF = process.env["SEALANT_CAPTURE_E2E_IMAGE"] ?? DEFAULT_IMAGE_REF;
const CAPTURE_TOKEN = "capture-harness-home-e2e-token";
const WORKTREE_ID = "capture-harness-home-e2e-worktree";
const HARNESS_HOME = "/workspace/harness-home";
const HARNESS_FILE = `${HARNESS_HOME}/state.json`;
const HARNESS_CONTENT = '{"session":"restored"}\n';

const createCaptureLaunchInput = (input: {
  readonly endpoint: string;
  readonly secretEnvDir: string;
  readonly runId: string;
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
        },
        inputs: [],
        mounts: [],
      },
      harness: { id: "opencode" },
      access: { ssh: { enabled: false, listenPort: 2222 } },
      tooling: { packages: [] },
      customization: {
        defaultShell: "bash",
        dotfilesManager: "auto",
        dotfilesTarget: "home",
        applyDotfiles: true,
        dotfilesBootstrap: true,
      },
      lifecycle: {
        setup: [],
        startup: { steps: [], foreground: { kind: "harness" } },
      },
      runtime: {
        env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        ociRuntime: "runc",
        network: { outbound: true },
      },
      target: {
        os: { family: "nix", mode: "prefer" },
        runtime: { family: "docker", mode: "prefer" },
      },
    },
    publishedImage: {
      repository: "sealant-workspace-fedora",
      tag: "latest",
      reference: IMAGE_REF,
      digestReference: IMAGE_REF,
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    runId: input.runId,
    secretEnvDir: input.secretEnvDir,
    secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
  });

const flushCapture = (containerId: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(sealantTargetForDockerContainer(containerId));
        return yield* session.captureFlush();
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

const containers = new Set<string>();
const temporaryDirectories = new Set<string>();
let channel: CaptureChannel | undefined;

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

describe.skipIf(!imageAvailable)("capture harness home restoration through the real daemon", () => {
  it("captures harness state from one executor and restores it into another", async () => {
    channel = await startCaptureChannel({ token: CAPTURE_TOKEN, worktreeId: WORKTREE_ID });
    const secretEnvDir = await mkdtemp(join(tmpdir(), "sealant-capture-home-secrets-"));
    temporaryDirectories.add(secretEnvDir);
    await chmod(secretEnvDir, 0o700);
    await writeFile(
      join(secretEnvDir, "env.json"),
      JSON.stringify({ SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN }),
      { mode: 0o600 },
    );

    const adapter = new DockerRuntimeAdapter({
      autoRemove: false,
      containerNamePrefix: "sealant-capture-home-e2e",
      runtimeCatalogLoader: async () => ({
        defaultRuntime: "runc",
        runtimes: new Set(["runc"]),
      }),
      workspaceNetwork: "host",
    });

    const first = await adapter.launch(
      createCaptureLaunchInput({
        endpoint: channel.endpoint,
        secretEnvDir,
        runId: `capture-home-source-${randomUUID()}`,
      }),
    );
    containers.add(first.resourceId);

    await docker(["exec", first.resourceId, "mkdir", "-p", HARNESS_HOME]);
    await docker([
      "exec",
      first.resourceId,
      "sh",
      "-c",
      `printf '%s' '${HARNESS_CONTENT.trimEnd()}' > '${HARNESS_FILE}'`,
    ]);

    const flush = await flushCapture(first.resourceId);
    expect(flush.fenced).toBe(false);
    expect(flush.pending).toBe(0);
    expect(channel.state.head).toBeDefined();
    expect(channel.state.objects.size).toBeGreaterThan(0);

    await docker(["rm", "-f", first.resourceId]);
    containers.delete(first.resourceId);

    const second = await adapter.launch(
      createCaptureLaunchInput({
        endpoint: channel.endpoint,
        secretEnvDir,
        runId: `capture-home-restore-${randomUUID()}`,
      }),
    );
    containers.add(second.resourceId);

    expect(await docker(["exec", second.resourceId, "cat", HARNESS_FILE])).toBe(
      HARNESS_CONTENT.trimEnd(),
    );
    expect(channel.state.planRequests).toBeGreaterThanOrEqual(2);
    expect(channel.state.errors).toEqual([]);
  }, 180_000);
});
