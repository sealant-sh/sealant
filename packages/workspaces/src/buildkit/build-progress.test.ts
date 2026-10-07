/**
 * An image build reports where it is (step N of M, when it last wrote output), a build that keeps
 * writing is never cut short however slow it is, and one that goes silent is stopped and fails
 * with the step it stopped on (`image-build-stalled`). BuildKit's cache directory is used only
 * when one is configured.
 */
import type { NewWorkspace } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { createImageBuildProgressTracker, type ImageBuildProgress } from "./build-progress.js";
import {
  COMMAND_ABORTED_CODE,
  COMMAND_IDLE_TIMEOUT_CODE,
  IMAGE_BUILD_STALLED_CODE,
  compileWorkspaceBuildSpec,
  removeBuildContext,
  runBuildkitCommand,
  type BuildkitCommandOptions,
} from "./buildkit-builder.js";

const blueprint: NewWorkspace = {
  version: "1",
  sources: {
    workspace: {
      kind: "git",
      provider: "generic",
      url: "https://github.com/example/repo.git",
      ref: "main",
    },
    inputs: [],
    mounts: [],
  },
  harness: { id: "opencode" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: { packages: [] },
  customization: {
    defaultShell: "zsh",
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
    env: {},
    userEnv: {},
    credentialRefs: [],
    dotfilesArchives: [],
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace/repo",
    persistence: "ephemeral",
    envFrom: [],
    kubernetes: {},
    ociRuntime: "runc",
    network: { outbound: true },
  },
  target: {
    os: { family: "ubuntu", mode: "require" },
    runtime: { family: "docker", mode: "require" },
  },
};

const APT_STEP = "#5 [2/12] RUN apt-get update && apt-get install -y --no-install-recommends zsh";

describe("createImageBuildProgressTracker", () => {
  it("keeps the furthest step and when the build last wrote, across chunk boundaries", () => {
    const seen: ImageBuildProgress[] = [];
    let clock = Date.parse("2026-10-07T20:44:02.000Z");
    const tracker = createImageBuildProgressTracker({
      onProgress: (progress) => seen.push(progress),
      stallTimeoutMs: 600_000,
      now: () => new Date(clock),
    });

    tracker.write("#1 [internal] load build definition from Containerfile\n");
    expect(tracker.current()).toEqual({
      progressAt: "2026-10-07T20:44:02.000Z",
      stallTimeoutMs: 600_000,
    });

    tracker.write("#4 [1/12] FROM docker.io/library/ubuntu:24.04\n#5 [2/12] RUN apt-get upd");
    clock += 1_000;
    tracker.write("ate && apt-get install -y --no-install-recommends zsh\n#5 12.3 Get:1 http://ar");
    tracker.write("chive.ubuntu.com/ubuntu noble InRelease\n");
    expect(tracker.current()).toMatchObject({
      step: 2,
      steps: 12,
      stepName: "RUN apt-get update && apt-get install -y --no-install-recommends zsh",
      progressAt: "2026-10-07T20:44:03.000Z",
    });

    // An interleaved header of an earlier step does not move the build backwards.
    clock += 1_000;
    tracker.write("#6 [3/12] COPY --from=sealantd / /\n#4 [1/12] FROM docker.io/library/ubuntu\n");
    expect(tracker.current()).toMatchObject({
      step: 3,
      steps: 12,
      progressAt: "2026-10-07T20:44:04.000Z",
    });
    expect(seen).toHaveLength(5);
  });

  it("reads the classic builder's steps and shortens long instructions", () => {
    const tracker = createImageBuildProgressTracker({});
    tracker.write(`Step 7/9 : RUN ${"x".repeat(300)}\n`);
    const progress = tracker.current();
    expect(progress).toMatchObject({ step: 7, steps: 9 });
    expect(progress?.stepName?.length).toBeLessThanOrEqual(120);
    expect(progress?.stepName?.endsWith("…")).toBe(true);
  });
});

describe("runBuildkitCommand's idle bound", () => {
  it("lets a slow command that keeps writing finish", async () => {
    const output: string[] = [];
    const result = await runBuildkitCommand(
      "sh",
      ["-c", "for i in 1 2 3 4 5 6; do echo line $i; sleep 0.1; done"],
      { idleTimeoutMs: 400, onOutput: (text) => output.push(text) },
    );
    expect(result.stdout).toContain("line 6");
    expect(output.join("")).toContain("line 1");
  });

  it("stops a command that went silent and fails it as idle, not as a signal exit", async () => {
    const startedAt = Date.now();
    await expect(
      runBuildkitCommand("sh", ["-c", "echo started; sleep 30; echo never"], {
        idleTimeoutMs: 300,
      }),
    ).rejects.toMatchObject({
      code: COMMAND_IDLE_TIMEOUT_CODE,
      message: expect.stringContaining("wrote nothing"),
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("runBuildkitCommand's stop path", () => {
  it("settles a silent command that already exited, though a grandchild holds its output", async () => {
    const startedAt = Date.now();
    await expect(
      runBuildkitCommand("sh", ["-c", "sleep 20 & exit 0"], { idleTimeoutMs: 300 }),
    ).rejects.toMatchObject({ code: COMMAND_IDLE_TIMEOUT_CODE });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("stops a command when its signal aborts", async () => {
    const controller = new AbortController();
    const running = runBuildkitCommand("sh", ["-c", "echo started; sleep 30; echo never"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(running).rejects.toMatchObject({ code: COMMAND_ABORTED_CODE });
  });
});

describe("compileWorkspaceBuildSpec progress", () => {
  it("reports the build's steps while it runs, however long it takes", async () => {
    const seen: ImageBuildProgress[] = [];
    const commandRunner = vi.fn(
      async (_command: string, args: string[], options?: BuildkitCommandOptions) => {
        if (args[0] === "build") {
          options?.onOutput?.(`#4 [1/12] FROM docker.io/library/ubuntu:24.04\n${APT_STEP}\n`);
          options?.onOutput?.("#5 61.2 Fetched 70.1 MB in 6min 42s (174 kB/s)\n");
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: {
        commandRunner,
        emitTarball: false,
        stallTimeoutMs: 600_000,
        onProgress: (progress) => seen.push(progress),
      },
    });
    const contextDirectory = result.buildkit.spec.contextDirectory;
    await removeBuildContext(contextDirectory);

    const buildCall = commandRunner.mock.calls.find(([, args]) => args[0] === "build");
    expect(buildCall?.[2]).toMatchObject({ idleTimeoutMs: 600_000 });
    expect(buildCall?.[1]).toContain("--progress=plain");
    expect(seen.at(-1)).toMatchObject({
      step: 2,
      steps: 12,
      stallTimeoutMs: 600_000,
    });
  });

  it("fails a build that went silent with the step it stopped on", async () => {
    const commandRunner = vi.fn(
      async (_command: string, args: string[], options?: BuildkitCommandOptions) => {
        if (args[0] === "build") {
          options?.onOutput?.(`${APT_STEP}\n#5 3.1 Get:1 http://archive.ubuntu.com/ubuntu\n`);
          const error = new Error("docker wrote nothing for 600 s and was stopped") as Error & {
            code: string;
          };
          error.code = COMMAND_IDLE_TIMEOUT_CODE;
          throw error;
        }
        return { stdout: "", stderr: "" };
      },
    );

    await expect(
      compileWorkspaceBuildSpec({
        blueprint,
        options: { commandRunner, emitTarball: false, stallTimeoutMs: 600_000 },
      }),
    ).rejects.toMatchObject({
      code: IMAGE_BUILD_STALLED_CODE,
      message: expect.stringMatching(
        /stopped making progress at step 2\/12 \(RUN apt-get update.*\): it wrote nothing for 10 min/,
      ),
    });
  });

  it("keeps BuildKit's cache in the configured directory, one per image name", async () => {
    const commandRunner = vi.fn(async (_command: string, _args: string[]) => ({
      stdout: "",
      stderr: "",
    }));
    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: {
        commandRunner,
        emitTarball: false,
        cacheDirectory: "/var/cache/sealant-buildkit",
      },
    });
    await removeBuildContext(result.buildkit.spec.contextDirectory);

    const args = commandRunner.mock.calls.find(([, call]) => call[0] === "build")?.[1] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--cache-from",
        "type=local,src=/var/cache/sealant-buildkit/sealant-workspace-ubuntu",
        "--cache-to",
        "type=local,dest=/var/cache/sealant-buildkit/sealant-workspace-ubuntu,mode=max",
      ]),
    );
  });

  it("passes no cache flags when no cache directory is configured", async () => {
    const commandRunner = vi.fn(async (_command: string, _args: string[]) => ({
      stdout: "",
      stderr: "",
    }));
    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner, emitTarball: false },
    });
    await removeBuildContext(result.buildkit.spec.contextDirectory);
    const args = commandRunner.mock.calls.find(([, call]) => call[0] === "build")?.[1] ?? [];
    expect(args).not.toContain("--cache-from");
    expect(args).not.toContain("--cache-to");
  });
});
