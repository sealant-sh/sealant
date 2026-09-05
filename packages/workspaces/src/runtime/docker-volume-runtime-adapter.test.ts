import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { baseBlueprint, publishedImage } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter, type DockerCommandRunner } from "./docker-runtime-adapter.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);
const RUNNING_STATE = '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n';

interface RecordingRunner {
  readonly calls: Array<readonly string[]>;
  readonly runner: DockerCommandRunner;
}

const recordingRunner = (
  options: {
    readonly missingVolume?: string;
    readonly apiVersion?: string;
    readonly runError?: Error;
    readonly adopted?: boolean;
    readonly credentialWriteError?: Error;
  } = {},
): RecordingRunner => {
  const calls: Array<readonly string[]> = [];
  const runner: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "version") {
      const version = options.apiVersion ?? "1.47";
      return { stdout: `${version}|${version}\n`, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args[2] === options.missingVolume) throw new Error(`No such volume: ${args[2]}`);
      return { stdout: "[]\n", stderr: "" };
    }
    if (args[0] === "run") {
      if (options.runError !== undefined) throw options.runError;
      return { stdout: "container-volume-1\n", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{.Id}}\t{{.State.Running}}")) {
      if (options.adopted) return { stdout: "adopted-container\ttrue\n", stderr: "" };
      throw new Error("No such container");
    }
    if (args[0] === "inspect" && (args.includes("{{.Id}}") || args.length === 2)) {
      throw new Error("No such container");
    }
    if (args[0] === "inspect") return { stdout: RUNNING_STATE, stderr: "" };
    if (args[0] === "exec" && args.includes("-i") && options.credentialWriteError !== undefined) {
      throw options.credentialWriteError;
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, runner };
};

type WorkspaceNameOutcome = "absent" | "live" | "unknown";

const lifecycleRunner = (options: {
  readonly workspaceNameOutcome: WorkspaceNameOutcome;
  readonly workspaceRunError?: Error;
  readonly sidecarNameOutcome?: WorkspaceNameOutcome;
  readonly sidecarRunError?: Error;
  readonly credentialWriteError?: Error;
  readonly cleanupError?: Error;
}): RecordingRunner => {
  const calls: Array<readonly string[]> = [];
  const runner: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "version") return { stdout: "1.47|1.47\n", stderr: "" };
    if (args[0] === "volume") return { stdout: "[]\n", stderr: "" };
    if (args[0] === "network" && args[1] === "create") {
      return { stdout: "created-network-id\n", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "rm" && options.cleanupError !== undefined) {
      throw options.cleanupError;
    }
    if (args[0] === "run") {
      if (args.includes("--privileged")) {
        if (options.sidecarRunError !== undefined) throw options.sidecarRunError;
        return { stdout: "docker-service-id\n", stderr: "" };
      }
      if (options.workspaceRunError !== undefined) throw options.workspaceRunError;
      return { stdout: "workspace-container-id\n", stderr: "" };
    }
    if (args[0] === "exec" && args.includes("-i") && options.credentialWriteError !== undefined) {
      throw options.credentialWriteError;
    }
    if (args[0] === "exec") return { stdout: "", stderr: "" };
    if (args[0] === "inspect") {
      const name = args.at(-1) ?? "";
      const nameOutcome = name.endsWith("-docker")
        ? (options.sidecarNameOutcome ?? "absent")
        : options.workspaceNameOutcome;
      if (args.includes("{{json .State}}")) return { stdout: RUNNING_STATE, stderr: "" };
      if (nameOutcome === "live") {
        return {
          stdout: args.includes("{{.Id}}\t{{.State.Running}}")
            ? "live-workspace-id\ttrue\n"
            : "live-workspace-id\n",
          stderr: "",
        };
      }
      if (nameOutcome === "absent") throw new Error("No such container");
      throw new Error("Docker daemon unavailable");
    }
    if (args[0] === "container") {
      const filter = args.find((arg) => arg.startsWith("name=")) ?? "";
      const nameOutcome = filter.includes("-docker$")
        ? (options.sidecarNameOutcome ?? "absent")
        : options.workspaceNameOutcome;
      if (nameOutcome === "live") return { stdout: "live-container-id\n", stderr: "" };
      if (nameOutcome === "absent") return { stdout: "", stderr: "" };
      throw new Error("Docker daemon unavailable");
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, runner };
};

const expectSocketAccepting = async (socketPath: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("Control socket connection timed out"));
    });
  });
};

const catalog = async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc", "runsc"]) });

const createInput = (
  blueprintOverrides: Record<string, unknown>,
  launchOverrides: Record<string, unknown> = {},
) =>
  parseRuntimeAdapterLaunchInput({
    blueprint: baseBlueprint(blueprintOverrides),
    publishedImage,
    runId: "volume-1",
    ...launchOverrides,
  });

const mountOptionValues = (args: readonly string[]): readonly string[] =>
  args.flatMap((arg, index) => (args[index - 1] === "--mount" ? [arg] : []));

describe("DockerRuntimeAdapter strict named-volume mode", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  const startControlSocket = async (socketPath: string): Promise<void> => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  };

  const deployment = async () => {
    const root = await mkdtemp(join(tmpdir(), "sealant-docker-volumes-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const storeRoot = join(root, "store");
    const socketRoot = join(root, "sockets");
    await mkdir(storeRoot);
    await mkdir(socketRoot);
    return {
      root,
      storeRoot,
      socketRoot,
      mappings: [
        { logicalRoot: storeRoot, volumeName: "mend-store" },
        { logicalRoot: socketRoot, volumeName: "sealant-sockets" },
      ],
    } as const;
  };

  it("lowers primary, git-common, ordinary, read-only, and launch-material mounts", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const workspace = join(storeRoot, "acme", "worktrees", "session-1");
    const gitCommon = join(storeRoot, "acme", "repo.git");
    const reference = join(storeRoot, "references", "effect");
    const scratch = join(storeRoot, "scratch");
    const dotfiles = join(socketRoot, "_dotfiles", "dotfiles-volume-1");
    const secrets = join(socketRoot, "_dotfiles", "secrets-volume-1");
    await Promise.all(
      [workspace, gitCommon, reference, scratch, dotfiles, secrets].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      mountAllowedStoreRoots: storeRoot,
      volumeMappings: mappings,
    });
    const input = createInput(
      {
        sources: {
          workspace: { kind: "mount", hostPath: workspace },
          inputs: [],
          mounts: [
            { hostPath: gitCommon, mountPath: gitCommon, readOnly: false },
            { hostPath: reference, mountPath: "/workspace/ref/effect", readOnly: true },
            { hostPath: scratch, mountPath: "/workspace/scratch", readOnly: false },
          ],
        },
      },
      { dotfilesArchiveDir: dotfiles, secretEnvDir: secrets },
    );

    await adapter.launch(input);

    const runArgs = recording.calls.find((args) => args[0] === "run") ?? [];
    expect(runArgs).not.toContain("-v");
    expect(mountOptionValues(runArgs)).toEqual([
      "type=volume,src=sealant-sockets,dst=/run/sealant,volume-subpath=sealant-volume-1,volume-nocopy",
      "type=volume,src=sealant-sockets,dst=/run/sealant/dotfiles,volume-subpath=_dotfiles/dotfiles-volume-1,volume-nocopy,readonly",
      "type=volume,src=sealant-sockets,dst=/run/sealant/secrets,volume-subpath=_dotfiles/secrets-volume-1,volume-nocopy,readonly",
      "type=volume,src=mend-store,dst=/workspace/repo,volume-subpath=acme/worktrees/session-1,volume-nocopy",
      `type=volume,src=mend-store,dst=${gitCommon},volume-subpath=acme/repo.git,volume-nocopy`,
      "type=volume,src=mend-store,dst=/workspace/ref/effect,volume-subpath=references/effect,volume-nocopy,readonly",
      "type=volume,src=mend-store,dst=/workspace/scratch,volume-subpath=scratch,volume-nocopy",
    ]);
    expect(runArgs).toContain(`SEALANT_WORKSPACE_MOUNT_HOST_PATH=${workspace}`);
    expect(runArgs).toContain(`SEALANT_MOUNT_ALLOWED_STORE_ROOTS=${storeRoot}`);
    expect(recording.calls.filter((args) => args[0] === "volume" && args[1] === "inspect")).toEqual(
      [
        ["volume", "inspect", "sealant-sockets"],
        ["volume", "inspect", "mend-store"],
      ],
    );
  });

  it("lowers standby and bindable roots to their hidden destinations", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const standby = join(storeRoot, "acme", "worktrees");
    const sibling = join(storeRoot, "api", "worktrees");
    await Promise.all([standby, sibling].map((directory) => mkdir(directory, { recursive: true })));
    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      mountAllowedStoreRoots: storeRoot,
      volumeMappings: mappings,
    });

    await adapter.launch(
      createInput(
        {
          sources: {
            workspace: { kind: "standby", rootPath: standby },
            inputs: [],
            mounts: [
              {
                hostPath: sibling,
                mountPath: "/workspace/repos/api",
                readOnly: false,
                bindable: true,
              },
            ],
          },
        },
        {
          binds: [
            { mountPath: "/workspace/repo", subpath: "session-1" },
            { mountPath: "/workspace/repos/api", subpath: "main" },
          ],
        },
      ),
    );

    const runArgs = recording.calls.find((args) => args[0] === "run") ?? [];
    expect(mountOptionValues(runArgs)).toEqual([
      "type=volume,src=sealant-sockets,dst=/run/sealant,volume-subpath=sealant-volume-1,volume-nocopy",
      "type=volume,src=mend-store,dst=/workspace/.roots/workspace,volume-subpath=acme/worktrees,volume-nocopy",
      "type=volume,src=mend-store,dst=/workspace/.roots/workspace__repos__api,volume-subpath=api/worktrees,volume-nocopy",
    ]);
    expect(runArgs.some((arg) => arg.includes("dst=/workspace/repo,"))).toBe(false);
    expect(runArgs).toContain("SEALANT_WORKSPACE_SOURCE=standby");
  });

  it("checks source directories before provisioning a requested sidecar", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      mountAllowedStoreRoots: storeRoot,
      volumeMappings: mappings,
    });
    const missing = join(storeRoot, "missing", "session");

    await expect(
      adapter.launch(
        createInput({
          sources: { workspace: { kind: "mount", hostPath: missing }, inputs: [], mounts: [] },
          tooling: { packages: [], services: { docker: { enabled: true } } },
        }),
      ),
    ).rejects.toThrow(/does not exist/);
    expect(recording.calls.some((args) => args[0] === "network" || args[0] === "run")).toBe(false);
    await expect(stat(join(socketRoot, "sealant-volume-1"))).rejects.toThrow();
  });

  it("rejects a symlinked source through the real adapter before Docker provisioning", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const target = join(storeRoot, "target", "session");
    const source = join(storeRoot, "linked", "session");
    await mkdir(target, { recursive: true });
    await symlink(join(storeRoot, "target"), join(storeRoot, "linked"));
    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      mountAllowedStoreRoots: storeRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({
          sources: { workspace: { kind: "mount", hostPath: source }, inputs: [], mounts: [] },
        }),
      ),
    ).rejects.toThrow(/must not be a symbolic link/);
    expect(recording.calls).toHaveLength(0);
  });

  it("fails closed for an old API or a missing deployment volume without running a container", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const workspace = join(storeRoot, "acme", "session");
    await mkdir(workspace, { recursive: true });

    for (const recording of [
      recordingRunner({ apiVersion: "1.44" }),
      recordingRunner({ missingVolume: "mend-store" }),
    ]) {
      const adapter = new DockerRuntimeAdapter({
        commandRunner: recording.runner,
        runtimeCatalogLoader: catalog,
        verifyRunning: false,
        controlSocketHostDir: socketRoot,
        mountAllowedStoreRoots: storeRoot,
        volumeMappings: mappings,
      });
      await expect(
        adapter.launch(
          createInput({
            sources: { workspace: { kind: "mount", hostPath: workspace }, inputs: [], mounts: [] },
          }),
        ),
      ).rejects.toThrow(/API >= 1\.45|deployment must create and mount/);
      expect(recording.calls.some((args) => args[0] === "run")).toBe(false);
      await expect(stat(join(socketRoot, "sealant-volume-1"))).rejects.toThrow();
    }
  });

  it("keeps legacy bind-mode control directory creation compatible with symlinked roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "sealant-legacy-sockets-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketTarget = join(root, "target");
    const socketRoot = join(root, "current");
    await mkdir(socketTarget);
    await symlink(socketTarget, socketRoot);
    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
    });

    await adapter.launch(createInput({}));

    await expect(stat(join(socketTarget, "sealant-volume-1"))).resolves.toBeDefined();
    const runArgs = recording.calls.find((args) => args[0] === "run") ?? [];
    expect(runArgs).toContain(`${socketRoot}/sealant-volume-1:/run/sealant`);
  });

  it("retains strict control directories but cleans owned Docker resources after a pre-run auth failure", async () => {
    const { root, socketRoot, mappings } = await deployment();
    const recording = lifecycleRunner({ workspaceNameOutcome: "absent" });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({
          sources: {
            workspace: {
              kind: "git",
              provider: "generic",
              url: "https://example.com/acme/repo.git",
              ref: "main",
              authRef: join(root, "missing-key"),
            },
            inputs: [],
            mounts: [],
          },
          tooling: { packages: [], services: { docker: { enabled: true } } },
        }),
      ),
    ).rejects.toThrow(/Workspace clone key could not be read/);

    expect(
      recording.calls.filter((args) => args[0] === "run" && !args.includes("--privileged")),
    ).toHaveLength(0);
    expect(recording.calls).toContainEqual(["rm", "-f", "docker-service-id"]);
    expect(recording.calls).toContainEqual(["network", "rm", "created-network-id"]);
    await expect(stat(join(socketRoot, "sealant-volume-1"))).resolves.toBeDefined();
  });

  it("preserves resources when a failed workspace run leaves its named outcome unknown", async () => {
    const { socketRoot, mappings } = await deployment();
    const originalError = new Error("workspace run reply lost");
    const recording = lifecycleRunner({
      workspaceNameOutcome: "unknown",
      workspaceRunError: originalError,
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
      ),
    ).rejects.toBe(originalError);

    await expect(stat(join(socketRoot, "sealant-volume-1"))).resolves.toBeDefined();
    expect(recording.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
  });

  it("preserves a sidecar when its run reply and named outcome are both inconclusive", async () => {
    const { socketRoot, mappings } = await deployment();
    const originalError = new Error("sidecar run reply lost");
    const recording = lifecycleRunner({
      workspaceNameOutcome: "absent",
      sidecarNameOutcome: "unknown",
      sidecarRunError: originalError,
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
      ),
    ).rejects.toBe(originalError);

    expect(recording.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
    await expect(stat(join(socketRoot, "sealant-volume-1"))).resolves.toBeDefined();
  });

  it("cleans owned resources when a failed workspace run is confirmed absent", async () => {
    const { socketRoot, mappings } = await deployment();
    const originalError = new Error("workspace run failed before create");
    const recording = lifecycleRunner({
      workspaceNameOutcome: "absent",
      workspaceRunError: originalError,
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
      ),
    ).rejects.toBe(originalError);

    expect(recording.calls).toContainEqual(["rm", "-f", "docker-service-id"]);
    expect(recording.calls).toContainEqual(["network", "rm", "created-network-id"]);
    await expect(stat(join(socketRoot, "sealant-volume-1"))).resolves.toBeDefined();
  });

  it("preserves an adopted workspace and its Docker service after a later failure", async () => {
    const { socketRoot, mappings } = await deployment();
    const recording = lifecycleRunner({
      workspaceNameOutcome: "live",
      workspaceRunError: new Error("name conflict"),
      credentialWriteError: new Error("credential write failed"),
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput(
          { tooling: { packages: [], services: { docker: { enabled: true } } } },
          {
            credentialFiles: [
              {
                path: "$HOME/.codex/auth.json",
                contentBase64: Buffer.from("{}").toString("base64"),
                mode: "600",
              },
            ],
          },
        ),
      ),
    ).rejects.toThrow(/Failed to write credential file/);

    await expect(stat(join(socketRoot, "sealant-volume-1"))).resolves.toBeDefined();
    expect(recording.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
  });

  it("keeps the original launch error when cleanup also fails", async () => {
    const { root, socketRoot, mappings } = await deployment();
    const recording = lifecycleRunner({
      workspaceNameOutcome: "absent",
      cleanupError: new Error("network cleanup failed"),
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput({
          sources: {
            workspace: {
              kind: "git",
              provider: "generic",
              url: "https://example.com/acme/repo.git",
              ref: "main",
              authRef: join(root, "missing-key"),
            },
            inputs: [],
            mounts: [],
          },
          tooling: { packages: [], services: { docker: { enabled: true } } },
        }),
      ),
    ).rejects.toThrow(/Workspace clone key could not be read/);
  });

  it("does not treat a persistent stale socket inode as ready", async () => {
    const { socketRoot, mappings } = await deployment();
    const controlDirectory = join(socketRoot, "sealant-volume-1");
    const socketPath = join(controlDirectory, "control.sock");
    await mkdir(controlDirectory);
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import net from "node:net"; const server = net.createServer(); server.listen(process.env.SOCKET_PATH, () => process.exit(0));',
      ],
      { env: { ...process.env, SOCKET_PATH: socketPath } },
    );
    expect((await stat(socketPath)).isSocket()).toBe(true);

    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      readinessTimeoutMs: 100,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(adapter.launch(createInput({}))).rejects.toThrow(/did not become ready/);
    expect(recording.calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
    expect((await stat(socketPath)).isSocket()).toBe(true);
  });

  it("preserves an adopted container and its live socket when a later launch step fails", async () => {
    const { socketRoot, mappings } = await deployment();
    const controlDirectory = join(socketRoot, "sealant-volume-1");
    const socketPath = join(controlDirectory, "control.sock");
    await mkdir(controlDirectory);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const recording = recordingRunner({
      runError: new Error("name conflict"),
      adopted: true,
      credentialWriteError: new Error("credential write failed"),
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput(
          {},
          {
            credentialFiles: [
              {
                path: "$HOME/.codex/auth.json",
                contentBase64: Buffer.from("{}").toString("base64"),
                mode: "600",
              },
            ],
          },
        ),
      ),
    ).rejects.toThrow(/Failed to write credential file/);
    expect(recording.calls.some((args) => args[0] === "rm")).toBe(false);
    expect((await stat(socketPath)).isSocket()).toBe(true);
  });

  it.each(["stopped", "not-found"] as const)(
    "preserves replacement sidecars, networks, and a live socket during %s cleanup",
    async (outcome) => {
      const { socketRoot, mappings } = await deployment();
      const controlDirectory = join(socketRoot, "sealant-volume-1");
      const socketPath = join(controlDirectory, "control.sock");
      await mkdir(controlDirectory);
      const serviceName = "sealant-volume-1-docker";
      const networkName = "sealant-volume-1-network";
      const containers = new Map([[serviceName, "old-service-id"]]);
      const networks = new Map([[networkName, "old-network-id"]]);
      const calls: Array<readonly string[]> = [];
      const runner: DockerCommandRunner = async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "inspect") {
          const id = containers.get(args.at(-1) ?? "");
          if (id === undefined) throw new Error("No such container");
          return { stdout: `${id}\ttrue\n`, stderr: "" };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return { stdout: `${networks.get(networkName)}\n`, stderr: "" };
        }
        if (args[0] === "rm" && args[2] === "old-workspace-id") {
          // Removing the main container releases the run name. A retry immediately reuses all names.
          containers.set(serviceName, "replacement-service-id");
          networks.set(networkName, "replacement-network-id");
          await startControlSocket(socketPath);
          if (outcome === "not-found") throw new Error("No such container");
        } else if (args[0] === "rm") {
          if (args[2] === serviceName || args[2] === containers.get(serviceName)) {
            containers.delete(serviceName);
          } else {
            throw new Error("No such container");
          }
        } else if (args[0] === "network" && args[1] === "rm") {
          if (args[2] === networkName || args[2] === networks.get(networkName)) {
            networks.delete(networkName);
          } else {
            throw new Error("No such network");
          }
        }
        return { stdout: "", stderr: "" };
      };
      const adapter = new DockerRuntimeAdapter({
        commandRunner: runner,
        runtimeCatalogLoader: catalog,
        controlSocketHostDir: socketRoot,
        volumeMappings: mappings,
      });

      await expect(
        adapter.stop({ resourceId: "old-workspace-id", reference: "sealant-volume-1" }),
      ).resolves.toMatchObject({ outcome });

      expect(containers.get(serviceName)).toBe("replacement-service-id");
      expect(networks.get(networkName)).toBe("replacement-network-id");
      expect(calls).toContainEqual(["rm", "-f", "old-service-id"]);
      expect(calls).toContainEqual(["network", "rm", "old-network-id"]);
      await expectSocketAccepting(socketPath);
    },
  );

  it("preserves a replacement sidecar and live socket after owned workspace failure cleanup", async () => {
    const { socketRoot, mappings } = await deployment();
    const socketPath = join(socketRoot, "sealant-volume-1", "control.sock");
    const serviceName = "sealant-volume-1-docker";
    const containers = new Map([[serviceName, "docker-service-id"]]);
    const recording = lifecycleRunner({
      workspaceNameOutcome: "absent",
      sidecarNameOutcome: "live",
      credentialWriteError: new Error("credential write failed"),
    });
    const removals: string[] = [];
    const runner: DockerCommandRunner = async (command, args, options) => {
      if (args[0] === "rm" && args[2] === "workspace-container-id") {
        containers.set(serviceName, "replacement-service-id");
        await startControlSocket(socketPath);
      } else if (args[0] === "rm") {
        const target = args[2] ?? "";
        removals.push(target);
        if (target === serviceName || target === containers.get(serviceName)) {
          containers.delete(serviceName);
        } else {
          throw new Error("No such container");
        }
      }
      return recording.runner(command, args, options);
    };
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.launch(
        createInput(
          { tooling: { packages: [], services: { docker: { enabled: true } } } },
          {
            credentialFiles: [
              {
                path: "$HOME/.codex/auth.json",
                contentBase64: Buffer.from("{}").toString("base64"),
                mode: "600",
              },
            ],
          },
        ),
      ),
    ).rejects.toThrow(/Failed to write credential file/);

    expect(removals).toEqual(["docker-service-id"]);
    expect(containers.get(serviceName)).toBe("replacement-service-id");
    expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
    await expectSocketAccepting(socketPath);
  });

  it.each(["workspace", "sidecar"] as const)(
    "removes only the created network ID after a %s run failure and name reuse",
    async (failedRun) => {
      const { socketRoot, mappings } = await deployment();
      const originalError = new Error(`${failedRun} run failed`);
      const networkName = "sealant-volume-1-network";
      const networks = new Map([[networkName, "created-network-id"]]);
      const recording = lifecycleRunner({
        workspaceNameOutcome: "absent",
        ...(failedRun === "workspace"
          ? { workspaceRunError: originalError }
          : { sidecarRunError: originalError }),
      });
      const removals: string[] = [];
      const runner: DockerCommandRunner = async (command, args, options) => {
        if (args[0] === "inspect" && args.at(-1) === "sealant-volume-1-docker") {
          // The sidecar is absent, but its old network is replaced before cleanup can remove it.
          networks.set(networkName, "replacement-network-id");
        }
        if (args[0] === "network" && args[1] === "rm") {
          const target = args[2] ?? "";
          removals.push(target);
          if (target === networkName || target === networks.get(networkName)) {
            networks.delete(networkName);
          } else {
            throw new Error("No such network");
          }
        }
        return recording.runner(command, args, options);
      };
      const adapter = new DockerRuntimeAdapter({
        commandRunner: runner,
        runtimeCatalogLoader: catalog,
        verifyRunning: false,
        controlSocketHostDir: socketRoot,
        volumeMappings: mappings,
      });

      await expect(
        adapter.launch(
          createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
        ),
      ).rejects.toBe(originalError);

      expect(removals).toEqual(["created-network-id"]);
      expect(networks.get(networkName)).toBe("replacement-network-id");
    },
  );

  it.each(["failed", "empty", "malformed"] as const)(
    "preserves sidecars and networks when stop inspection is %s",
    async (inspection) => {
      const calls: Array<readonly string[]> = [];
      const runner: DockerCommandRunner = async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "inspect" && inspection === "failed") {
          throw new Error("Docker daemon unavailable");
        }
        return { stdout: inspection === "malformed" ? "container-id\tunknown\n" : "", stderr: "" };
      };
      const adapter = new DockerRuntimeAdapter({ commandRunner: runner });

      await expect(
        adapter.stop({ resourceId: "workspace-id", reference: "sealant-volume-1" }),
      ).resolves.toMatchObject({ outcome: "stopped" });

      expect(calls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", "workspace-id"]]);
      expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
    },
  );

  it.each(["adopted", "unknown-id"] as const)(
    "retains an %s network after owned sidecar cleanup",
    async (network) => {
      const originalError = new Error("workspace run failed");
      const recording = lifecycleRunner({
        workspaceNameOutcome: "absent",
        workspaceRunError: originalError,
      });
      const runner: DockerCommandRunner = async (command, args, options) => {
        if (args[0] === "network" && args[1] === "create") {
          if (network === "adopted") throw new Error("network already exists");
          return { stdout: "", stderr: "" };
        }
        return recording.runner(command, args, options);
      };
      const adapter = new DockerRuntimeAdapter({
        commandRunner: runner,
        runtimeCatalogLoader: catalog,
        verifyRunning: false,
      });

      await expect(
        adapter.launch(
          createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
        ),
      ).rejects.toBe(originalError);

      expect(recording.calls).toContainEqual(["rm", "-f", "docker-service-id"]);
      expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
    },
  );

  it("preserves an adopted sidecar and its network after workspace launch fails", async () => {
    const originalError = new Error("workspace run failed");
    const recording = lifecycleRunner({
      workspaceNameOutcome: "absent",
      workspaceRunError: originalError,
      sidecarNameOutcome: "live",
      sidecarRunError: new Error("sidecar name conflict"),
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      verifyRunning: false,
    });

    await expect(
      adapter.launch(
        createInput({ tooling: { packages: [], services: { docker: { enabled: true } } } }),
      ),
    ).rejects.toBe(originalError);

    expect(recording.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(recording.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
  });

  it("keeps the control directory when Docker cannot prove the container is gone", async () => {
    const { socketRoot, mappings } = await deployment();
    const controlDirectory = join(socketRoot, "sealant-volume-1");
    await mkdir(controlDirectory);
    const runner: DockerCommandRunner = async (_command, args) => {
      if (args[0] === "rm") throw new Error("Docker daemon unavailable");
      if (args[0] === "inspect") return { stdout: RUNNING_STATE, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: socketRoot,
      volumeMappings: mappings,
    });

    await expect(
      adapter.stop({ resourceId: "container-volume-1", reference: "sealant-volume-1" }),
    ).rejects.toThrow(/Failed to remove workspace container/);
    await expect(stat(controlDirectory)).resolves.toBeDefined();
  });

  it("retains the control directory after stop succeeds and leaves store data intact", async () => {
    const { storeRoot, socketRoot, mappings } = await deployment();
    const controlDirectory = join(socketRoot, "sealant-volume-1");
    const userData = join(storeRoot, "acme", "session", "work.txt");
    await mkdir(controlDirectory);
    await mkdir(join(storeRoot, "acme", "session"), { recursive: true });
    await writeFile(join(controlDirectory, "stale.sock"), "stale");
    await writeFile(userData, "keep");
    const recording = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: recording.runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: socketRoot,
      mountAllowedStoreRoots: storeRoot,
      volumeMappings: mappings,
    });

    await adapter.stop({ resourceId: "container-volume-1", reference: "sealant-volume-1" });

    await expect(stat(controlDirectory)).resolves.toBeDefined();
    await expect(stat(userData)).resolves.toBeDefined();
    expect(recording.calls).toContainEqual(["rm", "-f", "container-volume-1"]);
  });
});
