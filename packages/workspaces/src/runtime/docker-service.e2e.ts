import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DockerRuntimeAdapter, type DockerCommandRunner } from "./docker-runtime-adapter.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);
const docker: DockerCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

describe("workspace Docker service", () => {
  let fixtureDir: string;
  let image: string;
  let adapter: DockerRuntimeAdapter;
  let launched: { readonly resourceId: string; readonly reference: string } | undefined;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "sealant-docker-service-"));
    image = `sealant-docker-service-fixture:${process.pid}`;
    await writeFile(
      join(fixtureDir, "Dockerfile"),
      [
        "FROM docker:27.5.1-cli",
        "RUN mkdir -p /workspace/repo",
        'ENTRYPOINT ["sleep"]',
        'CMD ["infinity"]',
        "",
      ].join("\n"),
    );
    await docker("docker", ["build", "-t", image, fixtureDir]);
    adapter = new DockerRuntimeAdapter({
      commandRunner: docker,
      runtimeCatalogLoader: async () => ({
        defaultRuntime: "runc",
        runtimes: new Set(["runc"]),
      }),
      verifyRunning: false,
      mountAllowedStoreRoots: fixtureDir,
      readinessTimeoutMs: 120_000,
    });

    launched = await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        runId: `docker-service-e2e-${process.pid}`,
        blueprint: {
          version: "1",
          sources: {
            workspace: { kind: "mount", hostPath: fixtureDir },
            inputs: [],
            mounts: [],
          },
          harness: { id: "opencode" },
          access: { ssh: { enabled: false, listenPort: 2222 } },
          tooling: { packages: [], services: { docker: { enabled: true } } },
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
            env: {},
            credentialRefs: [],
            workspaceRoot: "/workspace",
            workingDirectory: "/workspace/repo",
            persistence: "ephemeral",
            ociRuntime: "runc",
            network: { outbound: true },
          },
          target: {
            os: { family: "arch", mode: "prefer" },
            runtime: { family: "docker", mode: "require" },
          },
        },
        publishedImage: {
          repository: "sealant/docker-service-fixture",
          tag: "e2e",
          reference: image,
          digestReference: image,
          digest: "sha256:e2e-fixture",
        },
      }),
    );
  }, 180_000);

  afterAll(async () => {
    if (launched !== undefined) {
      await adapter.stop({ resourceId: launched.resourceId, reference: launched.reference });
    }
    if (image !== undefined) {
      await docker("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    }
    if (fixtureDir !== undefined) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("runs a nested container through the workspace-scoped daemon", async () => {
    const result = await docker("docker", [
      "exec",
      launched?.resourceId ?? "missing-workspace",
      "docker",
      "run",
      "--rm",
      "alpine:3.20",
      "echo",
      "nested-ok",
    ]);

    expect(result.stdout.trim()).toBe("nested-ok");
  }, 120_000);
});
