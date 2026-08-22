/**
 * Golden regression for the Docker adapter's generated `docker` invocations.
 *
 * Kubernetes support adds a second lowering of the same blueprint (PVC + subPath). This file pins
 * the FIRST lowering exactly — every argument, in order — so the seams introduced around the
 * adapter (`collectMountIntents`, `LaunchMaterialStager`, generic target derivation) can never
 * change what a Docker self-host deployment runs. The expected arrays were captured from the
 * adapter on `main` before any of that work landed. If a change here is intentional, update the
 * literal and say why in the commit.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cases } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";

const RUNNING_STATE = '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n';

const recordingRunner = () => {
  const calls: string[][] = [];
  const runner = vi.fn(async (_command: string, args: string[]) => {
    calls.push([...args]);
    if (args[0] === "run") {
      return { stdout: "container-id-123\n", stderr: "" };
    }
    if (args[0] === "network") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "exec" && args.includes("info")) {
      return { stdout: "ok", stderr: "" };
    }
    return { stdout: RUNNING_STATE, stderr: "" };
  });
  return { calls, runner };
};

const catalog = async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc", "runsc"]) });

describe("DockerRuntimeAdapter golden argv", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("git source: every env channel in its documented precedence order", async () => {
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
    });

    await adapter.launch(cases.gitSource);

    expect(calls).toEqual([
      [
        "run",
        "-d",
        "--runtime",
        "runc",
        "--name",
        "sealant-run-golden-1",
        "-w",
        "/workspace/repo",
        "-e",
        "SEALANT_WORKSPACE_HTTP_USERNAME=x-access-token",
        "-e",
        "SEALANT_WORKSPACE_HTTP_TOKEN=ghs_secret",
        "-e",
        "SEALANT_WORKSPACE_REPO_URL=https://github.com/example/repo.git",
        "-e",
        "SEALANT_WORKSPACE_REPO_REF=main",
        "-e",
        "SEALANT_OCI_RUNTIME=runc",
        "-e",
        "SEALANT_HARNESS_BANNER=Starting opencode workspace",
        "-e",
        "SEALANT_HARNESS_LAUNCH_COMMAND=opencode",
        "-e",
        "NODE_ENV=development",
        "-e",
        "SEALANT_DOTFILES_HTTP_TOKEN=dot_secret",
        "-e",
        "GITHUB_TOKEN=gh_secret",
        "-e",
        "CLAUDE_CODE_OAUTH_TOKEN=cc_secret",
        "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      ],
      ["inspect", "--format", "{{json .State}}", "container-id-123"],
      ["exec", "container-id-123", "test", "-S", "/run/sealant/control.sock"],
    ]);
  });

  it("mount source: launch material, workspace, extra mounts and the control-socket fast path", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "sealant-golden-"));
    await mkdir(join(socketDir, "sealant-run-golden-2"), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(join(socketDir, "sealant-run-golden-2", "control.sock"), resolve),
    );
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketDir, { recursive: true, force: true });
    });

    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: socketDir,
      mountAllowedStoreRoots: "/var/lib/mend/store",
    });

    await adapter.launch(cases.mendMount);

    expect(calls).toEqual([
      [
        "run",
        "-d",
        "--runtime",
        "runsc",
        "--name",
        "sealant-run-golden-2",
        "-e",
        "EDITOR=vim",
        "-w",
        "/workspace/repo",
        "-v",
        `${socketDir}/sealant-run-golden-2:/run/sealant`,
        "-v",
        "/run/sealant/sockets/_dotfiles/sealant-dotfiles-run-golden-2:/run/sealant/dotfiles:ro",
        "-e",
        "SEALANT_DOTFILES_ARCHIVE_DIR=/run/sealant/dotfiles",
        "-v",
        "/run/sealant/sockets/_dotfiles/sealant-secret-env-run-golden-2:/run/sealant/secrets:ro",
        "-e",
        "SEALANT_SECRET_ENV_FILE=/run/sealant/secrets/env.json",
        "-v",
        "/var/lib/mend/store/acme/worktrees/session-1:/workspace/repo",
        "-v",
        "/var/lib/mend/store/acme/repo.git:/var/lib/mend/store/acme/repo.git",
        "-v",
        "/var/lib/mend/store/_references/lib:/workspace/ref/lib:ro",
        "-v",
        "/var/lib/mend/store/_run/sessions/1:/run/mend:ro",
        "-e",
        "SEALANT_WORKSPACE_SOURCE=mount",
        "-e",
        "SEALANT_WORKSPACE_MOUNT_HOST_PATH=/var/lib/mend/store/acme/worktrees/session-1",
        "-e",
        "SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/var/lib/mend/store",
        "-e",
        "SEALANT_OCI_RUNTIME=runsc",
        "-e",
        "SEALANT_HARNESS_BANNER=Starting claude-code workspace",
        "-e",
        "SEALANT_HARNESS_LAUNCH_COMMAND=claude",
        "-e",
        "MEND_SESSION_ID=1",
        "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      ],
      ["inspect", "--format", "{{json .State}}", "container-id-123"],
    ]);
  });

  it("dind: network + privileged sidecar + workspace joined to it", async () => {
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
    });

    await adapter.launch(cases.dind);

    expect(calls).toEqual([
      ["network", "create", "sealant-run-golden-3-network"],
      [
        "run",
        "-d",
        "--privileged",
        "--name",
        "sealant-run-golden-3-docker",
        "--network",
        "sealant-run-golden-3-network",
        "--network-alias",
        "docker",
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "--label",
        "sealant.workspace=sealant-run-golden-3",
        "docker:27.5.1-dind-rootless",
        "--tls=false",
      ],
      ["exec", "container-id-123", "docker", "-H", "tcp://127.0.0.1:2375", "info"],
      [
        "run",
        "-d",
        "--runtime",
        "runc",
        "--name",
        "sealant-run-golden-3",
        "--network",
        "sealant-run-golden-3-network",
        "-e",
        "DOCKER_HOST=tcp://docker:2375",
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-w",
        "/workspace/repo",
        "-e",
        "SEALANT_WORKSPACE_REPO_URL=https://github.com/example/repo.git",
        "-e",
        "SEALANT_WORKSPACE_REPO_REF=main",
        "-e",
        "SEALANT_OCI_RUNTIME=runc",
        "-e",
        "SEALANT_HARNESS_BANNER=Starting opencode workspace",
        "-e",
        "SEALANT_HARNESS_LAUNCH_COMMAND=opencode",
        "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      ],
      ["inspect", "--format", "{{json .State}}", "container-id-123"],
      ["exec", "container-id-123", "test", "-S", "/run/sealant/control.sock"],
    ]);
  });
});
