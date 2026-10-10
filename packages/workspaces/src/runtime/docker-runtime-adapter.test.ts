import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { LaunchRetainedError } from "./launch-retention.js";
import {
  isRemovalRefusal,
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
} from "./runtime-adapter.js";

const createBlueprint = (overrides: Record<string, unknown> = {}) => {
  const base = {
    version: "1",
    sources: {
      workspace: {
        kind: "git" as const,
        provider: "generic" as const,
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [] as const,
    },
    harness: {
      id: "opencode" as const,
    },
    access: {
      ssh: {
        enabled: false,
        listenPort: 2222,
      },
    },
    tooling: {
      packages: [] as const,
    },
    customization: {
      defaultShell: "bash" as const,
      dotfilesManager: "auto" as const,
      dotfilesTarget: "home" as const,
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [] as const,
      startup: {
        steps: [] as const,
        foreground: {
          kind: "harness" as const,
        },
      },
    },
    runtime: {
      env: {} as Record<string, string>,
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral" as const,
      ociRuntime: "runc" as const,
      network: {
        outbound: true,
      },
    },
    target: {
      os: {
        family: "nix" as const,
        mode: "prefer" as const,
      },
      runtime: {
        family: "auto" as const,
        mode: "prefer" as const,
      },
    },
  };
  const override = overrides as any;

  return parseRuntimeAdapterSupportInput({
    blueprint: {
      ...base,
      ...override,
      sources: {
        ...base.sources,
        ...override.sources,
        // A mount override REPLACES the git base outright (the strict union rejects mixed shapes).
        workspace:
          override.sources?.workspace?.kind === "mount" ||
          override.sources?.workspace?.kind === "standby" ||
          override.sources?.workspace?.kind === "capture"
            ? override.sources.workspace
            : {
                ...base.sources.workspace,
                ...override.sources?.workspace,
              },
        inputs: override.sources?.inputs ?? base.sources.inputs,
      },
      access: {
        ...base.access,
        ...override.access,
        ssh: {
          ...base.access.ssh,
          ...override.access?.ssh,
        },
      },
      runtime: {
        ...base.runtime,
        ...override.runtime,
        env: {
          ...base.runtime.env,
          ...override.runtime?.env,
        },
        network: {
          ...base.runtime.network,
          ...override.runtime?.network,
        },
      },
      target: {
        ...base.target,
        ...override.target,
        os: {
          ...base.target.os,
          ...override.target?.os,
        },
        runtime: {
          ...base.target.runtime,
          ...override.target?.runtime,
        },
      },
    },
  }).blueprint;
};

const createLaunchInput = (overrides: Record<string, unknown> = {}) => {
  return parseRuntimeAdapterLaunchInput({
    blueprint: createBlueprint(overrides),
    publishedImage: {
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      digest: "sha256:test",
    },
  });
};

const createRuntimeCatalogLoader = (runtimes: ReadonlyArray<string> = ["runc", "runsc"]) => {
  return vi.fn(async () => ({
    defaultRuntime: "runc",
    runtimes: new Set(runtimes),
  }));
};

/** The short-lived run that refuses the cloud metadata address in a container's namespace. */
const isMetadataGuard = (args: ReadonlyArray<string>): boolean =>
  args[0] === "run" && args.includes("NET_ADMIN");

describe("DockerRuntimeAdapter", () => {
  it("provisions an isolated Docker daemon service instead of mounting the host socket", async () => {
    let runCount = 0;
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "network" && args[1] === "create") {
        return { stdout: "network-id\n", stderr: "" };
      }
      if (isMetadataGuard(args)) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        runCount += 1;
        return {
          stdout: runCount === 1 ? "docker-service-id\n" : "workspace-id\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      verifyRunning: false,
    });

    await adapter.launch(
      createLaunchInput({
        tooling: {
          packages: [],
          services: { docker: { enabled: true } },
        },
      }),
    );

    const runCalls = commandRunner.mock.calls.filter(
      (call) => call[1]?.[0] === "run" && !isMetadataGuard(call[1]),
    );
    expect(runCalls).toHaveLength(2);
    // The metadata address is refused in the Docker service's namespace and the workspace's.
    const guarded = commandRunner.mock.calls
      .filter((call) => isMetadataGuard(call[1]))
      .map((call) => call[1][call[1].indexOf("--network") + 1]);
    expect(guarded).toEqual(["container:docker-service-id", "container:workspace-id"]);
    const daemonArgs = runCalls[0]?.[1] ?? [];
    const workspaceArgs = runCalls[1]?.[1] ?? [];
    expect(daemonArgs).toContain("--privileged");
    expect(daemonArgs).toContain("--network-alias");
    expect(daemonArgs).toContain("docker");
    expect(daemonArgs).toContain("docker:27.5.1-dind-rootless");
    expect(daemonArgs).toContain("--tls=false");
    expect(workspaceArgs).toContain("DOCKER_HOST=tcp://docker:2375");
    expect(workspaceArgs).toContain("--network");
    expect(workspaceArgs.join(" ")).not.toContain("/var/run/docker.sock");
  });

  it("hands the Docker service its registry mirrors and puts the mirror on its network first", async () => {
    let runCount = 0;
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "network" && args[1] === "create") {
        return { stdout: "network-id\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "connect") {
        // A missing mirror container never fails the launch: the daemon falls back to Docker Hub.
        throw new Error("Error response from daemon: No such container: mend-docker-mirror");
      }
      if (args[0] === "run") {
        runCount += 1;
        return {
          stdout: runCount === 1 ? "docker-service-id\n" : "workspace-id\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      verifyRunning: false,
      workspaceNetwork: "mend_default",
      registryMirrors: ["http://docker-mirror:5000"],
      registryMirrorContainer: "mend-docker-mirror",
    });

    await adapter.launch(
      createLaunchInput({
        tooling: {
          packages: [],
          services: { docker: { enabled: true } },
        },
      }),
    );

    const calls = commandRunner.mock.calls.map((call) => call[1] ?? []);
    const connectIndex = calls.findIndex((args) => args[0] === "network" && args[1] === "connect");
    const daemonIndex = calls.findIndex((args) => args[0] === "run");
    const sidecarNetwork = calls.find((args) => args[0] === "network" && args[1] === "create")?.[2];
    expect(calls[connectIndex]).toEqual([
      "network",
      "connect",
      "--alias",
      "docker-mirror",
      sidecarNetwork,
      "mend-docker-mirror",
    ]);
    expect(connectIndex).toBeLessThan(daemonIndex);
    const daemonArgs = calls[daemonIndex] ?? [];
    expect(daemonArgs.slice(daemonArgs.indexOf("docker:27.5.1-dind-rootless") + 1)).toEqual([
      "--tls=false",
      "--registry-mirror=http://docker-mirror:5000",
      "--insecure-registry=docker-mirror:5000",
    ]);
    // The daemon answers unauthenticated on 2375: it stays off the shared network.
    expect(daemonArgs.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(daemonArgs).not.toContain("mend_default");
  });

  it("refuses a workspace network name Docker would not accept", () => {
    expect(
      () =>
        new DockerRuntimeAdapter({
          runtimeCatalogLoader: createRuntimeCatalogLoader(),
          workspaceNetwork: "mend default; rm -rf /",
        }),
    ).toThrow(/SEALANT_DOCKER_WORKSPACE_NETWORK/);
    expect(
      () =>
        new DockerRuntimeAdapter({
          runtimeCatalogLoader: createRuntimeCatalogLoader(),
          workspaceNetwork: "mend_default",
        }),
    ).not.toThrow();
  });

  it("removes the acquired Docker service when the workspace container fails to launch", async () => {
    let runCount = 0;
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "network" && args[1] === "create") {
        return { stdout: "network-id\n", stderr: "" };
      }
      if (args[0] === "inspect") {
        throw new Error("No such container");
      }
      if (args[0] === "run") {
        runCount += 1;
        if (runCount === 2) {
          throw new Error("workspace image failed");
        }
        return { stdout: "docker-service-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      verifyRunning: false,
    });

    await expect(
      adapter.launch(
        createLaunchInput({
          tooling: {
            packages: [],
            services: { docker: { enabled: true } },
          },
        }),
      ),
    ).rejects.toThrow("workspace image failed");

    const removeCalls = commandRunner.mock.calls.filter(
      (call) => call[1]?.[0] === "rm" || call[1]?.[0] === "network",
    );
    expect(removeCalls).toEqual(
      expect.arrayContaining([
        ["docker", ["rm", "-f", "-v", "docker-service-id"]],
        ["docker", ["network", "rm", "network-id"]],
      ]),
    );
  });

  it("supports SSH-enabled blueprints without any key material configured", () => {
    // The gateway reaches workspaces over the daemon control socket; client keys are authorized
    // against the control plane, so the adapter needs no authorized-keys source.
    const adapter = new DockerRuntimeAdapter();
    const support = adapter.supports({
      blueprint: createBlueprint({
        access: {
          ssh: {
            enabled: true,
            listenPort: 2222,
          },
        },
      }),
    });

    expect(support).toEqual({ supported: true });
  });

  it("launches the published image with docker run", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-123\n",
          stderr: "",
        };
      }

      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.launch(
      createLaunchInput({
        target: {
          runtime: {
            family: "docker",
            mode: "prefer",
          },
        },
        runtime: {
          env: {
            NODE_ENV: "development",
          },
          workingDirectory: "/workspace/repo",
          persistence: "ephemeral",
          ociRuntime: "runc",
          network: {
            outbound: true,
          },
        },
      }),
    );

    // `run`, the metadata guard's `run`, a single running-state `inspect`
    // (assertContainerRunning), then one `exec test -S` control-socket readiness probe — the mock's
    // default branch answers the probe as "accepting".
    expect(commandRunner).toHaveBeenCalledTimes(4);
    expect(isMetadataGuard(commandRunner.mock.calls[1]?.[1] ?? [])).toBe(true);
    const firstCall = commandRunner.mock.calls[0];
    const command = firstCall?.[0];
    const args = firstCall?.[1];
    expect(command).toBe("docker");
    expect(args).toBeDefined();
    expect(args?.slice(0, 12)).toEqual([
      "run",
      "-d",
      "--runtime",
      "runc",
      "--name",
      expect.any(String),
      "--stop-timeout",
      "120",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-w",
      "/workspace/repo",
    ]);
    expect(args).not.toContain("--rm");
    expect(args).toContain("127.0.0.1:5000/sealant/workspaces/demo@sha256:test");
    expect(args).toContain("NODE_ENV=development");
    expect(args).toContain("SEALANT_WORKSPACE_REPO_URL=https://github.com/example/repo.git");
    expect(args).toContain("SEALANT_WORKSPACE_REPO_REF=main");
    expect(args).toContain("SEALANT_OCI_RUNTIME=runc");
    // Harness identity rides launch env, not image ENV — the image carries every baked harness.
    expect(args).toContain("SEALANT_HARNESS_BANNER=Starting opencode workspace");
    expect(args).toContain("SEALANT_HARNESS_LAUNCH_COMMAND=opencode");
    expect(result.adapter).toBe("docker");
    expect(result.resourceId).toBe("container-id-123");
    expect(result.status).toBe("ready");
  });

  it("bind-mounts a mount-sourced workspace at the working directory with the daemon's mount env contract", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-mount\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      mountAllowedStoreRoots: "/srv/store:/home/me/.mend/store",
    });

    await adapter.launch(
      createLaunchInput({
        sources: { workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" } },
      }),
    );

    const args = commandRunner.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    expect(args?.join(" ")).toContain("-v /srv/store/worktrees/session-1:/workspace/repo");
    expect(args).toContain("SEALANT_WORKSPACE_SOURCE=mount");
    expect(args).toContain("SEALANT_WORKSPACE_MOUNT_HOST_PATH=/srv/store/worktrees/session-1");
    expect(args).toContain("SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/srv/store:/home/me/.mend/store");
    // Mount mode must not carry any clone configuration — the daemon hard-rejects the combination.
    expect(args?.some((arg) => arg.startsWith("SEALANT_WORKSPACE_REPO_URL="))).toBe(false);
    expect(args?.some((arg) => arg.startsWith("SEALANT_WORKSPACE_REPO_REF="))).toBe(false);
  });

  it("bind-mounts extra mounts read-only by default and read-write only when the blueprint says so", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-extra\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      mountAllowedStoreRoots: "/srv/store",
    });

    await adapter.launch(
      createLaunchInput({
        sources: {
          workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" },
          mounts: [
            // No readOnly key: the blueprint default (read-only) must apply.
            { hostPath: "/srv/store/_references/effect", mountPath: "/workspace/ref/effect" },
            {
              hostPath: "/srv/store/scratch",
              mountPath: "/workspace/home/scratch",
              readOnly: false,
            },
          ],
        },
      }),
    );

    const args = commandRunner.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    const joined = args?.join(" ");
    expect(joined).toContain("-v /srv/store/worktrees/session-1:/workspace/repo");
    expect(joined).toContain("-v /srv/store/_references/effect:/workspace/ref/effect:ro");
    expect(joined).toContain("-v /srv/store/scratch:/workspace/home/scratch");
    expect(joined).not.toContain("/workspace/home/scratch:ro");
    // Extra mounts ride only -v binds; the daemon's mount env contract stays primary-mount-only.
    expect(args).toContain("SEALANT_WORKSPACE_MOUNT_HOST_PATH=/srv/store/worktrees/session-1");
  });

  it("launches a standby workspace with the root hidden, the working directory unbound, and the binds env", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-123\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      mountAllowedStoreRoots: "/srv/store",
    });
    await adapter.launch({
      ...createLaunchInput({
        sources: {
          workspace: { kind: "standby", rootPath: "/srv/store/acme/worktrees" },
          mounts: [
            {
              hostPath: "/srv/store/api/worktrees",
              mountPath: "/workspace/repos/api",
              readOnly: false,
              bindable: true,
            },
          ],
        },
      }),
      binds: [
        { mountPath: "/workspace/repo", subpath: "wt-1" },
        { mountPath: "/workspace/repos/api", subpath: "wt-main" },
      ],
    });
    const args = commandRunner.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    const joined = args?.join(" ");
    expect(joined).toContain("-v /srv/store/acme/worktrees:/workspace/.roots/workspace");
    expect(joined).toContain("-v /srv/store/api/worktrees:/workspace/.roots/workspace__repos__api");
    // The declared paths are the daemon's to bind: nothing is mounted there.
    expect(joined).not.toContain(":/workspace/repo ");
    expect(joined).not.toContain(":/workspace/repos/api");
    expect(args).toContain("SEALANT_WORKSPACE_SOURCE=standby");
    expect(args).toContain("SEALANT_WORKSPACE_MOUNT_HOST_PATH=/srv/store/acme/worktrees");
    expect(args).toContain("SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/srv/store");
    expect(args).toContain(
      `SEALANT_BINDABLE_MOUNTS=${JSON.stringify([
        {
          mountPath: "/workspace/repos/api",
          rootMountPath: "/workspace/.roots/workspace__repos__api",
          hostRootPath: "/srv/store/api/worktrees",
        },
      ])}`,
    );
    expect(args).toContain(
      `SEALANT_BINDS=${JSON.stringify([
        { mountPath: "/workspace/repo", subpath: "wt-1" },
        { mountPath: "/workspace/repos/api", subpath: "wt-main" },
      ])}`,
    );
    expect(args?.some((arg) => arg.startsWith("SEALANT_WORKSPACE_REPO_URL="))).toBe(false);
  });

  it("launches a capture workspace with no workspace bind and the channel facts as env", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-123\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    await adapter.launch({
      ...createLaunchInput({
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session/s1",
            worktreeId: "wt_1",
            harnessHome: "/workspace/harness-home",
          },
        },
        runtime: { env: { SEALANT_CAPTURE_HARNESS_HOME: "/legacy/override" } },
      }),
      secretEnvDir: "/host/staging/sealant-secret-env-run_capture",
      launchId: "launch-7",
    });
    const args = commandRunner.mock.calls[0]?.[1] ?? [];
    // The launch the create named: the daemon names it from its first plan request.
    expect(args).toContain("SEALANT_CAPTURE_LAUNCH_ID=launch-7");
    // Only launch material is bound; the working directory is the container's own disk.
    expect(args.filter((arg, index) => args[index - 1] === "-v" && arg !== undefined)).toEqual([
      "/host/staging/sealant-secret-env-run_capture:/run/sealant/secrets:ro",
    ]);
    expect(args).toContain("SEALANT_WORKSPACE_SOURCE=capture");
    expect(args).toContain("SEALANT_CAPTURE_ENDPOINT=https://mend.example.com/session/s1");
    expect(args).toContain("SEALANT_CAPTURE_WORKTREE_ID=wt_1");
    expect(args.filter((arg) => arg.startsWith("SEALANT_CAPTURE_HARNESS_HOME="))).toEqual([
      "SEALANT_CAPTURE_HARNESS_HOME=/workspace/harness-home",
    ]);
    expect(args).toContain("SEALANT_SECRET_ENV_FILE=/run/sealant/secrets/env.json");
    expect(args.some((arg) => arg.startsWith("SEALANT_WORKSPACE_REPO_URL="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("SEALANT_WORKSPACE_MOUNT_HOST_PATH="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("SEALANT_MOUNT_ALLOWED_STORE_ROOTS="))).toBe(false);
  });

  it("leaves SEALANT_CAPTURE_WORKTREE_ID unset for a standby capture executor", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    await adapter.launch({
      ...createLaunchInput({
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session/s1",
            harnessHome: "/workspace/harness-home",
          },
        },
      }),
      secretEnvDir: "/host/staging/sealant-secret-env-run_standby",
    });
    const args = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("SEALANT_WORKSPACE_SOURCE=capture");
    expect(args).toContain("SEALANT_CAPTURE_ENDPOINT=https://mend.example.com/session/s1");
    expect(args.some((arg) => arg.startsWith("SEALANT_CAPTURE_WORKTREE_ID"))).toBe(false);
    expect(args).toContain("SEALANT_CAPTURE_HARNESS_HOME=/workspace/harness-home");
  });

  it("omits the repo ref env entirely when the blueprint has no ref (remote default branch)", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-123\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(createLaunchInput({ sources: { workspace: { ref: undefined } } }));

    const args = commandRunner.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    expect(args).toContain("SEALANT_WORKSPACE_REPO_URL=https://github.com/example/repo.git");
    expect(args?.some((arg) => arg.startsWith("SEALANT_WORKSPACE_REPO_REF="))).toBe(false);
  });

  it("waits for the control socket to accept before reporting the workspace ready", async () => {
    let socketProbes = 0;
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-ready\n", stderr: "" };
      }
      if (args[0] === "exec") {
        socketProbes += 1;
        // The control socket only appears after the (mock) clone+boot — fail the first probes.
        if (socketProbes < 3) {
          throw new Error("test: control socket not present yet");
        }
        return { stdout: "", stderr: "" };
      }
      // inspect: the container stays up throughout.
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      readinessTimeoutMs: 5_000,
    });

    const result = await adapter.launch(createLaunchInput());

    expect(result.status).toBe("ready");
    expect(socketProbes).toBeGreaterThanOrEqual(3);
    const probeArgs = commandRunner.mock.calls.find((call) => call[1]?.[0] === "exec")?.[1];
    expect(probeArgs).toEqual([
      "exec",
      "container-id-ready",
      "test",
      "-S",
      "/run/sealant/control.sock",
    ]);
  });

  it("fails launch and force-removes the container when the control socket never becomes ready", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-stuck\n", stderr: "" };
      }
      if (args[0] === "exec") {
        throw new Error("test: control socket never appears");
      }
      if (args[0] === "logs") {
        return { stdout: "cloning workspace repository...\n", stderr: "" };
      }
      // inspect: still running (so it isn't treated as a fast-fail container exit).
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      readinessTimeoutMs: 150,
    });

    await expect(adapter.launch(createLaunchInput())).rejects.toThrow(
      /control socket did not become ready/,
    );
    const forceRemoved = commandRunner.mock.calls.some(
      (call) => call[1]?.[0] === "rm" && call[1]?.includes("-f"),
    );
    expect(forceRemoved).toBe(true);
  });

  it("bind-mounts the staged dotfiles archive dir read-only and points boot at it", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-run\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput(),
        dotfilesArchiveDir: "/tmp/sealant-dotfiles-run-1",
      }),
    );

    const runArgs = commandRunner.mock.calls.find((call) => call[1]?.[0] === "run")?.[1] ?? [];
    expect(runArgs).toContain("/tmp/sealant-dotfiles-run-1:/run/sealant/dotfiles:ro");
    expect(runArgs).toContain("SEALANT_DOTFILES_ARCHIVE_DIR=/run/sealant/dotfiles");
  });

  it("derives a deterministic per-run container name from runId", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-run\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({ ...createLaunchInput(), runId: "run-xyz" }),
    );

    const runArgs = commandRunner.mock.calls.find((call) => call[1]?.[0] === "run")?.[1] ?? [];
    const nameIndex = runArgs.indexOf("--name");
    expect(runArgs[nameIndex + 1]).toBe("sealant-run-xyz");
  });

  it("adopts an existing live container instead of double-launching the same run (#4)", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (isMetadataGuard(args)) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        // Simulate `docker run --name` conflicting with a container from a prior launch of this run.
        throw new Error(
          'Conflict. The container name "/sealant-run-abc" is already in use by another container',
        );
      }
      if (args[0] === "inspect" && args.includes("{{.Id}}\t{{.State.Running}}")) {
        // inspect-by-name (the adopt path): the prior container is still live.
        return { stdout: "existing-container-id\ttrue\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      // inspectContainerState (assertContainerRunning) + any other inspect.
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.launch(
      parseRuntimeAdapterLaunchInput({ ...createLaunchInput(), runId: "abc" }),
    );

    // Adopted the existing container rather than creating a duplicate.
    expect(result.resourceId).toBe("existing-container-id");
    expect(result.status).toBe("ready");
    // An adopted container is guarded too: its namespace may predate the guard.
    expect(
      commandRunner.mock.calls.some(
        (call) => isMetadataGuard(call[1]) && call[1].includes("container:existing-container-id"),
      ),
    ).toBe(true);
  });

  it("uses runsc when the blueprint requests it", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-runsc\n",
          stderr: "",
        };
      }

      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(["runc", "runsc"]),
    });

    await adapter.launch(
      createLaunchInput({
        runtime: {
          env: {},
          workingDirectory: "/workspace/repo",
          persistence: "ephemeral",
          ociRuntime: "runsc",
          network: {
            outbound: true,
            cloudMetadata: true,
          },
        },
      }),
    );

    // Opted in, so no guard: gVisor's netstack would not take its route anyway.
    expect(commandRunner.mock.calls.some((call) => isMetadataGuard(call[1]))).toBe(false);
    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("--runtime");
    expect(runArgs).toContain("runsc");
    expect(runArgs).toContain("SEALANT_OCI_RUNTIME=runsc");
  });

  it("fails when runsc is requested but not configured on the Docker host", async () => {
    const adapter = new DockerRuntimeAdapter({
      commandRunner: vi.fn(async () => ({ stdout: "", stderr: "" })),
      runtimeCatalogLoader: createRuntimeCatalogLoader(["runc"]),
    });

    await expect(
      adapter.launch(
        createLaunchInput({
          runtime: {
            env: {},
            workingDirectory: "/workspace/repo",
            persistence: "ephemeral",
            ociRuntime: "runsc",
            network: {
              outbound: true,
              cloudMetadata: true,
            },
          },
        }),
      ),
    ).rejects.toThrow("Docker runtime 'runsc' is not configured on this host.");
  });

  it("refuses a gVisor workspace that has not opted in to the cloud metadata address", async () => {
    const commandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(["runc", "runsc"]),
    });

    await expect(
      adapter.launch(
        createLaunchInput({
          runtime: {
            env: {},
            workingDirectory: "/workspace/repo",
            persistence: "ephemeral",
            ociRuntime: "runsc",
            network: { outbound: true },
          },
        }),
      ),
    ).rejects.toThrow("cannot refuse the cloud metadata address inside a gVisor (runsc) workspace");
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("launches an opted-in workspace without the metadata guard", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) =>
      args[0] === "run"
        ? { stdout: "container-id-open\n", stderr: "" }
        : { stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n', stderr: "" },
    );
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      createLaunchInput({
        tooling: { packages: [], services: { docker: { enabled: true } } },
        runtime: {
          env: {},
          workingDirectory: "/workspace/repo",
          persistence: "ephemeral",
          ociRuntime: "runc",
          network: { outbound: true, cloudMetadata: true },
        },
      }),
    );

    expect(commandRunner.mock.calls.some((call) => isMetadataGuard(call[1]))).toBe(false);
    // The workspace's run (the Docker service's has no working directory) keeps Docker's caps.
    const workspaceRun = commandRunner.mock.calls.find(
      (call) => call[1][0] === "run" && call[1].includes("-w"),
    )?.[1];
    expect(workspaceRun).toBeDefined();
    expect(workspaceRun).not.toContain("NET_RAW");
  });

  it("drops NET_RAW from a guarded workspace, so no packet socket skips the route", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) =>
      args[0] === "run"
        ? { stdout: "container-id-guarded\n", stderr: "" }
        : { stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n', stderr: "" },
    );
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(createLaunchInput());

    const workspaceRun = commandRunner.mock.calls.find((call) => call[1][1] === "-d")?.[1] ?? [];
    const drop = workspaceRun.indexOf("--cap-drop");
    expect(workspaceRun[drop + 1]).toBe("NET_RAW");
  });

  it("reports a container that exited before its guard error", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (isMetadataGuard(args)) {
        throw new Error("cannot join network of a non-running container");
      }
      if (args[0] === "run") return { stdout: "container-id-exited\n", stderr: "" };
      return {
        stdout: '{"Status":"exited","Running":false,"ExitCode":3,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const failure = await adapter.launch(createLaunchInput()).then(
      () => "launched",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).not.toContain("cloud metadata");
    expect(failure).toContain("3");
  });

  it("pulls the guard image once, and names the remedy when it cannot", async () => {
    const run = async (present: boolean, pullFails: boolean) => {
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        if (args[0] === "image" && !present) throw new Error("No such image");
        if (args[0] === "pull" && pullFails) throw new Error("pull access denied");
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
        networkGuardImage: "mirror.local/busybox:1.37",
      });
      const outcome = await adapter.prepareNetworkGuard().then(
        (ready) => ready,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return { outcome, pulls: commandRunner.mock.calls.filter((call) => call[1][0] === "pull") };
    };

    const present = await run(true, false);
    expect(present.outcome).toEqual({ image: "mirror.local/busybox:1.37", pulled: false });
    expect(present.pulls).toHaveLength(0);

    const pulled = await run(false, false);
    expect(pulled.outcome).toEqual({ image: "mirror.local/busybox:1.37", pulled: true });
    expect(pulled.pulls[0]?.[1]).toEqual(["pull", "-q", "mirror.local/busybox:1.37"]);

    const unreachable = await run(false, true);
    expect(unreachable.outcome).toContain("'mirror.local/busybox:1.37' could not be pulled");
    expect(unreachable.outcome).toContain("SEALANT_DOCKER_NETWORK_GUARD_IMAGE");
  });

  it("fails the launch when the metadata guard fails", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (isMetadataGuard(args)) throw new Error("RTNETLINK answers: Operation not permitted");
      if (args[0] === "run") return { stdout: "container-id-unguarded\n", stderr: "" };
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const failure = await adapter.launch(createLaunchInput()).then(
      () => "launched",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain("Could not refuse the cloud metadata address");
    // The remedy: the image, the variable that replaces it, and the opt-in.
    expect(failure).toContain("busybox:1.37@sha256:");
    expect(failure).toContain("SEALANT_DOCKER_NETWORK_GUARD_IMAGE");
    expect(failure).toContain("runtime.network.cloudMetadata");
    // The unguarded container is removed with the failed launch.
    expect(
      commandRunner.mock.calls.some(
        (call) => call[1][0] === "rm" && call[1].includes("container-id-unguarded"),
      ),
    ).toBe(true);
  });

  it("passes workspace clone auth when a workspace auth ref is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sealant-workspace-key-"));
    const keyFile = join(tempDir, "workspace_repo_key");
    await writeFile(keyFile, "PRIVATE KEY CONTENT\n", "utf8");

    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-789\n",
          stderr: "",
        };
      }

      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });

    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    try {
      await adapter.launch(
        createLaunchInput({
          sources: {
            workspace: {
              url: "https://github.com/example/repo.git",
              ref: "main",
              authRef: keyFile,
            },
          },
        }),
      );

      const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
      expect(runArgs.some((arg) => arg.startsWith("SEALANT_WORKSPACE_AUTH_KEY_BASE64="))).toBe(
        true,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes ephemeral HTTP token clone auth when provided", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-654\n",
          stderr: "",
        };
      }

      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput(),
        workspaceCloneAuth: {
          type: "http-token",
          username: "x-access-token",
          token: "github-installation-token",
        },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("SEALANT_WORKSPACE_HTTP_USERNAME=x-access-token");
    expect(runArgs).toContain("SEALANT_WORKSPACE_HTTP_TOKEN=github-installation-token");
  });

  it("fails launch when container exits immediately", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-123\n",
          stderr: "",
        };
      }

      if (args[0] === "inspect") {
        return {
          stdout: '{"Status":"exited","Running":false,"ExitCode":127,"Error":"exec failed"}\n',
          stderr: "",
        };
      }

      return {
        stdout: "bash: while: command not found\n",
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(adapter.launch(createLaunchInput())).rejects.toThrow(
      "exited immediately (status: exited, exitCode: 127, error: exec failed)",
    );
  });

  it("exposes a control endpoint without publishing or injecting an inner sshd when SSH access is enabled", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-456\n",
          stderr: "",
        };
      }

      if (args[0] === "inspect") {
        return {
          stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
          stderr: "",
        };
      }

      return {
        stdout: "",
        stderr: "",
      };
    });

    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.launch(
      createLaunchInput({
        access: {
          ssh: {
            enabled: true,
            listenPort: 2222,
          },
        },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    // §4.3: no inner-sshd plumbing — no published SSH port, no SEALANT_SSH_* env injection.
    expect(runArgs).not.toContain("-p");
    expect(runArgs.some((arg) => arg.startsWith("SEALANT_ENABLE_SSH"))).toBe(false);
    expect(runArgs.some((arg) => arg.startsWith("SEALANT_SSH_"))).toBe(false);
    // The endpoint is now the daemon control target (docker-exec reach), never an ssh:// URI.
    expect(result.endpoint).toBe("docker-exec://container-id-456/run/sealant/control.sock");
    expect(result.endpoint?.startsWith("ssh://")).toBe(false);
    // The gateway reaches the daemon by the container id (resourceId), unaffected by sshd removal.
    expect(result.resourceId).toBe("container-id-456");
    // No `docker port` / network-inspect discovery is performed anymore.
    const dockerSubcommands = commandRunner.mock.calls.map((call) => call[1]?.[0]);
    expect(dockerSubcommands).not.toContain("port");
  });

  it("surfaces the host socket endpoint for control-plane sessions even when SSH is disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sealant-sockets-"));
    const socketHostDir = join(tempDir, "sealant-sockets");

    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-fastpath\n",
          stderr: "",
        };
      }

      if (args[0] === "inspect") {
        return {
          stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
          stderr: "",
        };
      }

      return {
        stdout: "",
        stderr: "",
      };
    });

    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      controlSocketHostDir: socketHostDir,
      // This test exercises endpoint resolution, not readiness; no real daemon binds the bind-mounted
      // socket, so skip the control-socket probe (covered by dedicated probe tests).
      verifyRunning: false,
    });

    try {
      const result = await adapter.launch(
        createLaunchInput({
          access: {
            ssh: {
              enabled: false,
              listenPort: 2222,
            },
          },
        }),
      );

      const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
      const containerName = result.reference;
      // The control-socket parent dir is bind-mounted; still no SSH port published.
      expect(runArgs).toContain("-v");
      expect(runArgs).toContain(`${join(socketHostDir, containerName)}:/run/sealant`);
      expect(runArgs).not.toContain("-p");
      expect(result.endpoint).toBe(`unix://${join(socketHostDir, containerName, "control.sock")}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("joins credential env injections to the docker run -e args", async () => {
    const commandRunner = vi.fn<
      (
        command: string,
        args: Array<string>,
        options?: { input?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-cred-env\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput(),
        credentialEnv: {
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
          GITHUB_TOKEN: "gho_test",
        },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test");
    expect(runArgs).toContain("GITHUB_TOKEN=gho_test");
  });

  it("emits caller userEnv -e args before every platform-owned emission", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-user-env\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput({
          runtime: { userEnv: { APP_MODE: "review", EMPTY_VALUE: "" } },
        }),
        platformEnv: { SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token" },
        credentialEnv: { GITHUB_TOKEN: "gho_test" },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("APP_MODE=review");
    expect(runArgs).toContain("EMPTY_VALUE=");
    // docker applies last-wins for duplicate -e flags: userEnv < SEALANT_* controls < platformEnv
    // < credentialEnv, so a caller entry can never shadow anything platform-owned.
    expect(runArgs.indexOf("APP_MODE=review")).toBeLessThan(
      runArgs.indexOf("SEALANT_OCI_RUNTIME=runc"),
    );
    expect(runArgs.indexOf("SEALANT_OCI_RUNTIME=runc")).toBeLessThan(
      runArgs.indexOf("SEALANT_DOTFILES_HTTP_USERNAME=x-access-token"),
    );
    expect(runArgs.indexOf("SEALANT_DOTFILES_HTTP_USERNAME=x-access-token")).toBeLessThan(
      runArgs.indexOf("GITHUB_TOKEN=gho_test"),
    );
  });

  it("binds the staged secret env dir read-only and names it via SEALANT_SECRET_ENV_FILE only", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-secret-env\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput(),
        secretEnvDir: "/host/staging/sealant-secret-env-run_1",
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("/host/staging/sealant-secret-env-run_1:/run/sealant/secrets:ro");
    expect(runArgs).toContain("SEALANT_SECRET_ENV_FILE=/run/sealant/secrets/env.json");
    // The channel is a FILE: no secret name or value ever reaches the docker argv.
    expect(runArgs.filter((arg) => arg.includes("env.json"))).toHaveLength(1);
  });

  it("rejects launch input whose userEnv violates the workspace environment policy", () => {
    expect(() => createLaunchInput({ runtime: { userEnv: { GITHUB_TOKEN: "x" } } })).toThrow(
      /reserved/,
    );
    expect(() => createLaunchInput({ runtime: { userEnv: { SEALANT_ANYTHING: "x" } } })).toThrow(
      /reserved/,
    );
    expect(() => createLaunchInput({ runtime: { userEnv: { "BAD NAME": "x" } } })).toThrow(
      /A-Za-z_/,
    );
  });

  it("orders credentialEnv after legacy runtime.env so the injected token wins", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-cred-order\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        // Legacy `runtime.env` is unrestricted, so a stored spec CAN carry GITHUB_TOKEN; the
        // securely-resolved connected-account value must still win via last-wins ordering.
        ...createLaunchInput({ runtime: { env: { GITHUB_TOKEN: "user-set" } } }),
        credentialEnv: { GITHUB_TOKEN: "gho_test" },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs.indexOf("GITHUB_TOKEN=user-set")).toBeGreaterThan(-1);
    expect(runArgs.indexOf("GITHUB_TOKEN=user-set")).toBeLessThan(
      runArgs.indexOf("GITHUB_TOKEN=gho_test"),
    );
  });

  it("writes credential files over stdin after the container is ready", async () => {
    const contentBase64 = Buffer.from('{"tokens":{}}', "utf8").toString("base64");
    const commandRunner = vi.fn<
      (
        command: string,
        args: Array<string>,
        options?: { input?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-cred-file\n", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        ...createLaunchInput(),
        credentialFiles: [{ path: "$HOME/.codex/auth.json", contentBase64, mode: "600" }],
      }),
    );

    expect(result.status).toBe("ready");
    const writeCall = commandRunner.mock.calls.find(
      (call) => call[1]?.[0] === "exec" && call[1]?.includes("-i"),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall?.[1]).toEqual([
      "exec",
      "-i",
      "container-id-cred-file",
      "sh",
      "-c",
      'umask 077 && mkdir -p "$(dirname "$HOME/.codex/auth.json")" && base64 -d > "$HOME/.codex/auth.json" && chmod 600 "$HOME/.codex/auth.json"',
    ]);
    // The secret bytes travel over stdin only — never in argv.
    expect(writeCall?.[2]).toEqual({ input: contentBase64 });
    expect(writeCall?.[1]).not.toContain(contentBase64);
    // The write happened AFTER the readiness probe (`exec test -S`).
    const execCalls = commandRunner.mock.calls.filter((call) => call[1]?.[0] === "exec");
    expect(execCalls[execCalls.length - 1]?.[1]).toContain("-i");
  });

  it("fails the launch and removes the container when a credential file write fails", async () => {
    const commandRunner = vi.fn<
      (
        command: string,
        args: Array<string>,
        options?: { input?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-cred-fail\n", stderr: "" };
      }
      if (args[0] === "exec" && args.includes("-i")) {
        throw new Error("test: base64 write exploded");
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(
      adapter.launch(
        parseRuntimeAdapterLaunchInput({
          ...createLaunchInput(),
          credentialFiles: [
            {
              path: "$HOME/.codex/auth.json",
              contentBase64: Buffer.from("{}", "utf8").toString("base64"),
              mode: "600",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Failed to write credential file/);

    const forceRemoved = commandRunner.mock.calls.some(
      (call) => call[1]?.[0] === "rm" && call[1]?.includes("-f"),
    );
    expect(forceRemoved).toBe(true);
  });

  it("keeps a capture-sourced container whose credential write fails after readiness", async () => {
    // Once the daemon answers, a writer can run in the container: its disk may hold the only copy
    // of work. The launch fails, but the container is NOT removed; the identity rides the error.
    const commandRunner = vi.fn<
      (
        command: string,
        args: Array<string>,
        options?: { input?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-capture\n", stderr: "" };
      }
      if (args[0] === "exec" && args.includes("-i")) {
        throw new Error("test: base64 write exploded");
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    const onReady = vi.fn(async () => undefined);

    const failure = await adapter
      .launch(
        parseRuntimeAdapterLaunchInput({
          ...createLaunchInput({
            sources: {
              workspace: {
                kind: "capture",
                endpoint: "https://mend.example.com/session/s1",
                worktreeId: "wt_1",
              },
            },
          }),
          credentialFiles: [
            {
              path: "$HOME/.codex/auth.json",
              contentBase64: Buffer.from("{}", "utf8").toString("base64"),
              mode: "600",
            },
          ],
        }),
        { onReady },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(LaunchRetainedError);
    expect(failure).toMatchObject({
      code: "launch-retained",
      identity: { adapter: "docker", resourceId: "container-id-capture" },
    });
    // The identity was reported before the step that failed.
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "docker", resourceId: "container-id-capture" }),
    );
    expect(commandRunner.mock.calls.some((call) => call[1]?.[0] === "rm")).toBe(false);
  });

  const captureLaunchInput = () =>
    parseRuntimeAdapterLaunchInput({
      ...createLaunchInput({
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session/s1",
            worktreeId: "wt_1",
          },
        },
      }),
      runId: "abc",
    });

  it("keeps an exited capture container on a redelivered launch instead of removing its disk", async () => {
    // Review 2 #4: a stopped same-name container was `docker rm -f -v`'d and the launch retried;
    // for a capture workspace that container's disk may hold the only copy of staged work.
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        throw new Error(
          'Conflict. The container name "/sealant-run-abc" is already in use by another container',
        );
      }
      if (args[0] === "inspect" && args.includes("{{.Id}}\t{{.State.Running}}")) {
        return { stdout: "exited-container-id\tfalse\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const failure = await adapter.launch(captureLaunchInput()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(LaunchRetainedError);
    expect(failure).toMatchObject({
      identity: { adapter: "docker", resourceId: "exited-container-id", reference: "sealant-abc" },
    });
    expect(commandRunner.mock.calls.some((call) => call[1]?.[0] === "rm")).toBe(false);
    expect(commandRunner.mock.calls.filter((call) => call[1]?.[0] === "run")).toHaveLength(1);
  });

  it("keeps a started capture container whose control socket never answers, and never adds --rm", async () => {
    // Review 2 #5: sealantd boots and runs writers whether or not the readiness probe succeeds.
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "started-container-id\n", stderr: "" };
      }
      if (args[0] === "exec") {
        throw new Error("test: no socket yet");
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      readinessTimeoutMs: 50,
      autoRemove: true,
    });
    const onStarted = vi.fn(async () => undefined);

    const failure = await adapter.launch(captureLaunchInput(), { onStarted }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(LaunchRetainedError);
    expect(failure).toMatchObject({ identity: { resourceId: "started-container-id" } });
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "docker", resourceId: "started-container-id" }),
    );
    expect(commandRunner.mock.calls.some((call) => call[1]?.[0] === "rm")).toBe(false);
    const runArgs = commandRunner.mock.calls.find((call) => call[1]?.[0] === "run")?.[1] ?? [];
    expect(runArgs).not.toContain("--rm");
  });

  it("says so, and recovers anyway, when a recovery start cannot be guarded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        if (isMetadataGuard(args)) throw new Error("pull access denied");
        if (args[0] === "inspect" && args.at(-1) === "kept-id") {
          return {
            stdout: '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}\n',
            stderr: "",
          };
        }
        if (args[0] === "inspect") throw new Error("Error: No such object");
        if (args[0] === "network") throw new Error("Error: No such network");
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
        verifyRunning: false,
      });

      await expect(
        adapter.recover({ resourceId: "kept-id", reference: "sealant-kept" }),
      ).resolves.toEqual({
        outcome: "restarted",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Cloud metadata guard failed on a recovery start"),
        expect.objectContaining({ container: "sealant-kept" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("starts a parked Docker sidecar before the recovery boot, and parks it again when the start fails (e2e 6)", async () => {
    // e2e 6: the park stopped `<name>-docker`, recovery started the workspace container alone,
    // and its daemon counted the unreachable workspace Docker daemon as a writer still there on
    // every FINAL (`processes-remain`): the recovery never completed.
    const recoverWith = async (sidecar: "stopped" | "removed", workspaceStarts: boolean) => {
      const steps: string[] = [];
      let sidecarRunning = false;
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        const target = args.at(-1) ?? "";
        if (args[0] === "inspect" && target === "exited-id") {
          return {
            stdout: '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}\n',
            stderr: "",
          };
        }
        if (args[0] === "inspect" && target === "sealant-x-docker") {
          if (sidecar === "removed" && !sidecarRunning) throw new Error("Error: No such object");
          return { stdout: `sidecar-id\t${String(sidecarRunning)}\n`, stderr: "" };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          steps.push(`network inspect ${target}`);
          return { stdout: "[]", stderr: "" };
        }
        if (args[0] === "cp") {
          steps.push("cp marker");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "start") {
          steps.push(`start ${target}`);
          if (target === "sidecar-id") sidecarRunning = true;
          if (target === "exited-id" && !workspaceStarts) throw new Error("start failed");
          return { stdout: "", stderr: "" };
        }
        if (isMetadataGuard(args)) {
          steps.push(`guard ${args[args.indexOf("--network") + 1] ?? ""}`);
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "run") {
          steps.push(`run ${args[args.indexOf("--name") + 1] ?? ""}`);
          sidecarRunning = true;
          return { stdout: "sidecar-id\n", stderr: "" };
        }
        if (args[0] === "exec" && args.includes("info")) {
          steps.push(`ready ${args[1] ?? ""}`);
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "stop") {
          steps.push(`stop ${target}`);
          sidecarRunning = false;
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      const outcome = await adapter
        .recover({ resourceId: "exited-id", reference: "sealant-x" })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      return { outcome, steps };
    };

    const stopped = await recoverWith("stopped", true);
    expect(stopped.outcome).toEqual({ outcome: "restarted" });
    // Each start makes a new network namespace: both are guarded again.
    expect(stopped.steps).toEqual([
      "cp marker",
      "start sidecar-id",
      "guard container:sidecar-id",
      "ready sidecar-id",
      "start exited-id",
      "guard container:exited-id",
    ]);

    // Created `--rm`, the park removed it: created again on the workspace's network.
    const removed = await recoverWith("removed", true);
    expect(removed.outcome).toEqual({ outcome: "restarted" });
    expect(removed.steps).toContain("run sealant-x-docker");
    expect(removed.steps.indexOf("run sealant-x-docker")).toBeLessThan(
      removed.steps.indexOf("start exited-id"),
    );

    const failed = await recoverWith("stopped", false);
    expect(failed.outcome).toBe("start failed");
    expect(failed.steps.at(-1)).toBe("stop sidecar-id");
  });

  it("says when the recovery boot found nothing to save (exit 76), and fails any other exit (e2e 6)", async () => {
    const recoverExiting = async (exitCode: number) => {
      let started = false;
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        if (args[0] === "inspect" && args.at(-1) === "exited-id") {
          const code = started ? exitCode : 1;
          return {
            stdout: `{"Status":"exited","Running":false,"ExitCode":${String(code)},"Error":""}\n`,
            stderr: "",
          };
        }
        if (args[0] === "start") {
          started = true;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "exec") throw new Error("no socket");
        if (args[0] === "logs") {
          return {
            stdout: "",
            stderr:
              exitCode === 76
                ? "sealantd boot: nothing to save: never materialized (/workspace/repo)\n"
                : "sealantd boot: invalid boot configuration: recovery: not this executor's continuation\n",
          };
        }
        if (args[0] === "inspect") throw new Error("Error: No such object");
        if (args[0] === "network") throw new Error("Error: No such network");
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      return adapter
        .recover({ resourceId: "exited-id", reference: "sealant-x" })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    };

    expect(await recoverExiting(76)).toEqual({
      outcome: "nothing-to-save",
      detail: "sealantd boot: nothing to save: never materialized (/workspace/repo)",
    });
    expect(await recoverExiting(75)).toEqual(expect.stringContaining("exitCode: 75"));
  });

  it("recovers a retained container by starting it on its own disk, and only an ended one", async () => {
    const states: Record<string, string> = {
      "exited-id": '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}',
      "running-id": '{"Status":"running","Running":true,"ExitCode":0,"Error":""}',
    };
    const started: string[] = [];
    const steps: string[] = [];
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "inspect") {
        const id = args.at(-1) ?? "";
        const state = states[id];
        if (state === undefined) {
          throw new Error(`Error: No such container: ${id}`);
        }
        return { stdout: `${state}\n`, stderr: "" };
      }
      if (args[0] === "cp") {
        // The marker file must exist on the worker side when docker cp reads it.
        const { readFile: read } = await import("node:fs/promises");
        steps.push(`cp ${await read(args[1] ?? "", "utf8").then(() => "marker")} ${args[2] ?? ""}`);
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "start") {
        steps.push(`start ${args[1] ?? ""}`);
        started.push(args[1] ?? "");
        states[args[1] ?? ""] = '{"Status":"running","Running":true,"ExitCode":0,"Error":""}';
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected docker ${args.join(" ")}`);
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    expect(await adapter.recover({ resourceId: "exited-id", reference: "sealant-x" })).toEqual({
      outcome: "restarted",
    });
    expect(await adapter.recover({ resourceId: "running-id" })).toEqual({ outcome: "running" });
    expect(await adapter.recover({ resourceId: "gone-id" })).toEqual({ outcome: "missing" });
    expect(started).toEqual(["exited-id"]);
    // The recovery boot is asked for by sealantd's marker, copied in before the start.
    expect(steps).toEqual(["cp marker exited-id:/.sealantd-recovery", "start exited-id"]);
    expect(commandRunner.mock.calls.some((call) => call[1]?.[0] === "rm")).toBe(false);
  });

  it("rejects credential file paths with shell metacharacters instead of interpolating them", async () => {
    const commandRunner = vi.fn<
      (
        command: string,
        args: Array<string>,
        options?: { input?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return { stdout: "container-id-cred-badpath\n", stderr: "" };
      }
      if (args[0] === "exec" && args.includes("-i")) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(
      adapter.launch(
        parseRuntimeAdapterLaunchInput({
          ...createLaunchInput(),
          credentialFiles: [
            {
              path: '$HOME/.codex/auth.json"; rm -rf /; "',
              contentBase64: Buffer.from("{}", "utf8").toString("base64"),
              mode: "600",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/not allowed in an injection path/);

    // No write exec was attempted with the hostile path.
    const writeCalls = commandRunner.mock.calls.filter(
      (call) => call[1]?.[0] === "exec" && call[1]?.includes("-i"),
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("surfaces the docker-exec fallback endpoint when SSH access is disabled", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "run") {
        return {
          stdout: "container-id-no-ssh\n",
          stderr: "",
        };
      }

      if (args[0] === "inspect") {
        return {
          stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
          stderr: "",
        };
      }

      return {
        stdout: "",
        stderr: "",
      };
    });

    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      containerNamePrefix: "sealant-test",
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.launch(
      createLaunchInput({
        access: {
          ssh: {
            enabled: false,
            listenPort: 2222,
          },
        },
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.endpoint).toBe("docker-exec://container-id-no-ssh/run/sealant/control.sock");
  });

  it("stops a workspace and its snapshotted service by immutable IDs", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "inspect") {
        return { stdout: "docker-service-id\ttrue\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "network-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.stop({
      resourceId: "container-id-123",
      reference: "sealant-run-abc",
    });

    const removals = commandRunner.mock.calls.filter(
      ([, args]) => args[0] === "rm" || (args[0] === "network" && args[1] === "rm"),
    );
    expect(removals).toEqual([
      ["docker", ["rm", "-f", "-v", "container-id-123"]],
      ["docker", ["rm", "-f", "-v", "docker-service-id"]],
      ["docker", ["network", "rm", "network-id"]],
    ]);
    expect(result).toEqual({
      adapter: "docker",
      resourceId: "container-id-123",
      outcome: "stopped",
    });
  });

  it("ends a workspace in the end phase without removing it, and removes its remains in the remove phase", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "inspect" && args.includes("{{json .State}}")) {
        return {
          stdout: JSON.stringify({ Status: "exited", Running: false, ExitCode: 0, Error: "" }),
          stderr: "",
        };
      }
      if (args[0] === "inspect") {
        return { stdout: "docker-service-id\ttrue\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "network-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    // An exited container keeps its disk, sidecar and network: the worker stops in two phases.
    expect(adapter.keepsRemains).toBe(true);

    const ended = await adapter.stop({
      resourceId: "container-id-123",
      reference: "sealant-run-abc",
      phase: "end",
    });
    const endCalls = commandRunner.mock.calls.map(([, args]) => args[0]);
    // The planned SIGTERM, the kill that makes the end certain, the look at the state: no removal.
    expect(endCalls).toContain("stop");
    expect(endCalls).toContain("kill");
    expect(endCalls).not.toContain("rm");
    expect(ended).toEqual({
      adapter: "docker",
      resourceId: "container-id-123",
      outcome: "stopped",
    });

    commandRunner.mockClear();
    const removed = await adapter.stop({
      resourceId: "container-id-123",
      reference: "sealant-run-abc",
      phase: "remove",
    });
    const removeCalls = commandRunner.mock.calls.map(([, args]) => args);
    // Nothing signalled again; the container, its sidecar and its network go.
    expect(removeCalls.some((args) => args[0] === "stop" || args[0] === "kill")).toBe(false);
    expect(
      removeCalls.filter((args) => args[0] === "rm" || (args[0] === "network" && args[1] === "rm")),
    ).toEqual([
      ["rm", "-f", "-v", "container-id-123"],
      ["rm", "-f", "-v", "docker-service-id"],
      ["network", "rm", "network-id"],
    ]);
    expect(removed.outcome).toBe("stopped");
  });

  it("refuses to report an end over a container still running, and reports not-found for one already gone", async () => {
    const running = new DockerRuntimeAdapter({
      commandRunner: async (_command, args) =>
        args[0] === "inspect"
          ? {
              stdout: JSON.stringify({ Status: "running", Running: true, ExitCode: 0, Error: "" }),
              stderr: "",
            }
          : { stdout: "", stderr: "" },
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    await expect(running.stop({ resourceId: "container-id-123", phase: "end" })).rejects.toThrow(
      /still running/,
    );

    const gone = new DockerRuntimeAdapter({
      commandRunner: async (_command, args) => {
        if (args[0] === "inspect" || args[0] === "kill" || args[0] === "stop") {
          throw new Error("Error response from daemon: No such container: container-id-123");
        }
        return { stdout: "", stderr: "" };
      },
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });
    expect((await gone.stop({ resourceId: "container-id-123", phase: "end" })).outcome).toBe(
      "not-found",
    );
  });

  it("marks an end the daemon refused over a running container as the runtime's refusal, and a lost reply as unknown", async () => {
    const running = JSON.stringify({ Status: "running", Running: true, ExitCode: 0, Error: "" });
    const endWith = async (killError: string) => {
      const adapter = new DockerRuntimeAdapter({
        commandRunner: async (_command, args) => {
          if (args[0] === "inspect") return { stdout: running, stderr: "" };
          if (args[0] === "stop" || args[0] === "kill") throw new Error(killError);
          return { stdout: "", stderr: "" };
        },
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      return adapter.stop({ resourceId: "container-id-123", phase: "end" }).then(
        () => undefined,
        (error: unknown) => error,
      );
    };

    // The daemon answered and did not act (review 9 #5): the removal is given up and decided
    // again, never left issued for good on a runtime with no bound on a removal request.
    const refused = await endWith(
      "Error response from daemon: cannot kill container: permission denied",
    );
    expect(refused).toBeInstanceOf(Error);
    expect(isRemovalRefusal(refused)).toBe(true);
    expect(refused instanceof Error ? refused.message : "").toMatch(/still running/);

    // The CLI lost the daemon mid-request: an outcome nobody knows.
    const lost = await endWith("write EPIPE");
    expect(lost).toBeInstanceOf(Error);
    expect(isRemovalRefusal(lost)).toBe(false);
  });

  it("fails the removal when the sidecar is still present after it was asked to go, or when that could not be told", async () => {
    const removeWith = (
      runner: (args: Array<string>) => Promise<{ stdout: string; stderr: string }>,
    ) =>
      new DockerRuntimeAdapter({
        commandRunner: (_command, args) => runner(args),
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      }).stop({ resourceId: "container-id-123", reference: "sealant-run-abc", phase: "remove" });

    // The sidecar's `rm` fails and its state still reads: present.
    await expect(
      removeWith(async (args) => {
        if (args[0] === "inspect" && args.includes("sealant-run-abc-docker")) {
          return { stdout: "sidecar-id\ttrue\n", stderr: "" };
        }
        if (args[0] === "inspect" && args.includes("sidecar-id")) {
          return {
            stdout: JSON.stringify({ Status: "running", Running: true, ExitCode: 0, Error: "" }),
            stderr: "",
          };
        }
        if (args[0] === "rm" && args.includes("sidecar-id")) {
          throw new Error("Error response from daemon: device or resource busy");
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return { stdout: "network-id\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
    ).rejects.toThrow(/sidecar 'sealant-run-abc-docker' is still present/);

    // The sidecar's inspection failed for a reason other than its absence: unknown is not gone.
    await expect(
      removeWith(async (args) => {
        // Every look at the sidecar (by name, and the exact-name listing) fails the same way.
        if (args.some((arg) => arg.includes("sealant-run-abc-docker"))) {
          throw new Error("Error response from daemon: i/o timeout");
        }
        return { stdout: "", stderr: "" };
      }),
    ).rejects.toThrow(
      /whether its Docker sidecar 'sealant-run-abc-docker' remains could not be told/,
    );
  });

  it("fails the removal when the network is still there, and passes one Docker no longer knows", async () => {
    const removeWith = (networkRmError: string) =>
      new DockerRuntimeAdapter({
        commandRunner: async (_command, args) => {
          if (args[0] === "inspect" && args.includes("sealant-run-abc-docker")) {
            return { stdout: "sidecar-id\tfalse\n", stderr: "" };
          }
          if (args[0] === "network" && args[1] === "inspect") {
            return { stdout: "network-id\n", stderr: "" };
          }
          if (args[0] === "network" && args[1] === "rm") throw new Error(networkRmError);
          return { stdout: "", stderr: "" };
        },
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      }).stop({ resourceId: "container-id-123", reference: "sealant-run-abc", phase: "remove" });

    await expect(
      removeWith("Error response from daemon: error while removing network: has active endpoints"),
    ).rejects.toThrow(/network 'sealant-run-abc-network'/);
    expect(
      (await removeWith("Error response from daemon: network sealant-run-abc-network not found"))
        .outcome,
    ).toBe("stopped");
  });

  it("sends SIGTERM with the grace before removing, and kills outright on a fenced stop", async () => {
    const calls: Array<readonly string[]> = [];
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      calls.push(args);
      if (args[0] === "stop") {
        // A container that exited already: `docker stop` complains, the removal still runs.
        throw new Error("Error response from daemon: container is not running");
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.stop({ resourceId: "container-id-123" });
    expect(calls.filter((args) => args[0] === "stop" || args[0] === "rm")).toEqual([
      ["stop", "-t", "120", "container-id-123"],
      ["rm", "-f", "-v", "container-id-123"],
    ]);

    calls.length = 0;
    await new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      stopGraceSeconds: 600,
    }).stop({ resourceId: "container-id-123" });
    expect(calls.find((args) => args[0] === "stop")).toEqual([
      "stop",
      "-t",
      "600",
      "container-id-123",
    ]);

    calls.length = 0;
    await adapter.stop({ resourceId: "container-id-123", fence: true });
    expect(calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("creates every container with its own stop timeout, far longer for a capture workspace", async () => {
    // A plain `docker stop` (operator, host restart, Docker Desktop quitting) otherwise gives the
    // container Docker's 10 s: SIGKILL mid-flush lost a 300 MB node_modules file end to end.
    const runArgs = async (
      overrides: Record<string, unknown>,
      options: { stopGraceSeconds?: number; captureStopGraceSeconds?: number } = {},
    ) => {
      const commandRunner = vi.fn(async (_command: string, args: Array<string>) =>
        args[0] === "run"
          ? { stdout: "container-id-grace\n", stderr: "" }
          : { stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n', stderr: "" },
      );
      await new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
        ...options,
      }).launch(createLaunchInput(overrides));
      const run = commandRunner.mock.calls.find((call) => call[1][0] === "run")?.[1] ?? [];
      return run[run.indexOf("--stop-timeout") + 1];
    };
    const capture = {
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          worktreeId: "wt_1",
        },
      },
    };

    expect(await runArgs({})).toBe("120");
    expect(await runArgs(capture)).toBe("3600");
    expect(await runArgs(capture, { captureStopGraceSeconds: 7200 })).toBe("7200");
    expect(await runArgs({}, { stopGraceSeconds: 300 })).toBe("300");
  });

  it("gives a planned stop the container's own stop timeout when it is longer", async () => {
    const calls: Array<readonly string[]> = [];
    const commandRunner = vi.fn(async (_command: string, args: Array<string>) => {
      calls.push(args);
      if (args[0] === "inspect" && args.includes("{{.Config.StopTimeout}}")) {
        return { stdout: "3600\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    }).stop({ resourceId: "container-id-capture" });
    expect(calls.find((args) => args[0] === "stop")).toEqual([
      "stop",
      "-t",
      "3600",
      "container-id-capture",
    ]);
  });

  it("treats an already-removed container as a successful (not-found) stop", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async () => {
      throw new Error(
        "Command failed: docker rm -f container-id-123\nError response from daemon: No such container: container-id-123",
      );
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.stop({ resourceId: "container-id-123" });

    expect(result.outcome).toBe("not-found");
  });

  it("falls back to a structural inspect when the rm error prose is unrecognized", async () => {
    // rm fails with wording the regex doesn't know, but the follow-up inspect proves the
    // container is gone — idempotency must not hinge on docker's error copy.
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "rm") {
        throw new Error("Error response from daemon: removal already in progress (code 409)");
      }
      throw new Error("Error: No such object: container-id-123");
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.stop({ resourceId: "container-id-123" });

    expect(result.outcome).toBe("not-found");
  });

  it("waits for another removal of the same container instead of failing the stop (e2e 5)", async () => {
    // e2e 5: the exit reconciler removed an ended container while the lifecycle stop removed it
    // too; `docker rm` answered "removal ... already in progress" and the stop was recorded failed.
    let inspections = 0;
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "rm") {
        throw new Error(
          "Command failed: docker rm -f -v container-id-123\nError response from daemon: removal of container container-id-123 is already in progress",
        );
      }
      if (args[0] === "inspect") {
        inspections += 1;
        if (inspections <= 2) {
          return {
            stdout: '{"Status":"removing","Running":false,"ExitCode":0,"Error":""}\n',
            stderr: "",
          };
        }
        throw new Error("Error: No such object: container-id-123");
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.stop({ resourceId: "container-id-123", fence: true });

    expect(result.outcome).toBe("not-found");
  });

  it("parks an ended retained container: stops its Docker sidecar, never the container (e2e 5)", async () => {
    const calls: Array<readonly string[]> = [];
    const parkWith = async (workspace: string, sidecar: string | undefined) => {
      calls.length = 0;
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "inspect" && args.at(-1) === "container-1") {
          return { stdout: workspace, stderr: "" };
        }
        if (args[0] === "inspect" && args.at(-1) === "sealant-run-1-docker") {
          if (sidecar === undefined) throw new Error("Error: No such object: sealant-run-1-docker");
          return { stdout: sidecar, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      return adapter.parkRetained({ resourceId: "container-1", reference: "sealant-run-1" });
    };
    const EXITED = '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}\n';

    expect(await parkWith(EXITED, "sidecar-id\ttrue\n")).toEqual({
      stopped: ["sealant-run-1-docker"],
    });
    expect(calls).toContainEqual(["stop", "-t", "10", "sidecar-id"]);
    expect(
      calls.some(
        (args) => args[0] === "rm" || (args.includes("container-1") && args[0] === "stop"),
      ),
    ).toBe(false);

    // Already stopped, absent, or the container running again (recovered): nothing to do.
    expect(await parkWith(EXITED, "sidecar-id\tfalse\n")).toEqual({ stopped: [] });
    expect(await parkWith(EXITED, undefined)).toEqual({ stopped: [] });
    expect(await parkWith(RUNNING_STATE_JSON, "sidecar-id\ttrue\n")).toEqual({ stopped: [] });
    expect(calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("locates the container a lost launch created by its run's name (e2e 5)", async () => {
    const locateWith = async (answer: "found" | "missing" | "down") => {
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        expect(args).toEqual(["inspect", "--format", "{{.Id}}", "sealant-run_7"]);
        if (answer === "missing") throw new Error("Error: No such object: sealant-run_7");
        if (answer === "down") throw new Error("Cannot connect to the Docker daemon");
        return { stdout: "container-id-7\n", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      return adapter.locate({ runId: "run_7" });
    };
    await expect(locateWith("found")).resolves.toMatchObject({
      adapter: "docker",
      resourceId: "container-id-7",
      reference: "sealant-run_7",
    });
    await expect(locateWith("missing")).resolves.toBeUndefined();
    // Unknown is never taken for none.
    await expect(locateWith("down")).rejects.toThrow(/Cannot connect/);
  });

  it("removes the sidecar network of a workspace whose parked sidecar is gone", async () => {
    const calls: Array<readonly string[]> = [];
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "inspect" && args.at(-1) === "sealant-run-1-docker") {
        throw new Error("Error: No such object: sealant-run-1-docker");
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "network-id\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await adapter.stop({ resourceId: "container-1", reference: "sealant-run-1", fence: true });

    expect(calls).toContainEqual(["network", "rm", "network-id"]);
  });

  it("disconnects the registry mirror container before it removes a sidecar network", async () => {
    const calls: Array<readonly string[]> = [];
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "inspect" && args.at(-1) === "sealant-run-1-docker") {
        throw new Error("Error: No such object: sealant-run-1-docker");
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: "network-id\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "disconnect") {
        // Not on the network (a mirror recreated since): the removal still goes ahead.
        throw new Error("container mend-docker-mirror is not connected to network network-id");
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
      registryMirrors: ["http://docker-mirror:5000"],
      registryMirrorContainer: "mend-docker-mirror",
    });

    await adapter.stop({ resourceId: "container-1", reference: "sealant-run-1", fence: true });

    const networkCalls = calls.filter((call) => call[0] === "network" && call[1] !== "inspect");
    expect(networkCalls).toEqual([
      ["network", "disconnect", "--force", "network-id", "mend-docker-mirror"],
      ["network", "rm", "network-id"],
    ]);
  });

  it("refuses a registry mirror container name Docker would not accept", () => {
    expect(
      () =>
        new DockerRuntimeAdapter({
          runtimeCatalogLoader: createRuntimeCatalogLoader(),
          registryMirrorContainer: "mirror; rm -rf /",
        }),
    ).toThrow(/SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER/);
  });

  it("surfaces a stop failure that is NOT a missing container (so callers never record a false stop)", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async () => {
      throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(adapter.stop({ resourceId: "container-id-123" })).rejects.toThrow(
      /Failed to remove workspace container/,
    );
  });

  // Review 9 #5 (decision 27): the daemon's own error answer with the container still there is a
  // definitive refusal; a CLI that lost the daemon mid-request is an outcome nobody knows.
  it("marks a removal the daemon answered with an error as refused, and a lost one as unknown (review 9 #5)", async () => {
    const stopWith = async (rmError: Error) => {
      const commandRunner = vi.fn<
        (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
      >(async (_command, args) => {
        if (args[0] === "rm") {
          throw rmError;
        }
        if (args[0] === "inspect") {
          return {
            stdout: '{"Status":"exited","Running":false,"ExitCode":75,"Error":""}\n',
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });
      const adapter = new DockerRuntimeAdapter({
        commandRunner,
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
      });
      return adapter.stop({ resourceId: "container-id-123" }).then(
        () => "stopped",
        (error: unknown) => (isRemovalRefusal(error) ? "refused" : "unknown"),
      );
    };
    expect(
      await stopWith(
        new Error(
          "Command failed: docker rm -f -v container-id-123\nError response from daemon: cannot remove container: device or resource busy",
        ),
      ),
    ).toBe("refused");
    expect(
      await stopWith(new Error("Command failed: docker rm -f -v container-id-123\nunexpected EOF")),
    ).toBe("unknown");
  });
});

describe("cluster env references belt", () => {
  it("docker refuses runtime.envFrom / kubernetes.serviceAccountName", () => {
    const adapter = new DockerRuntimeAdapter({});
    const blueprint = createBlueprint({
      runtime: { kubernetes: { serviceAccountName: "dev-sa" } },
    });
    expect(adapter.supports(parseRuntimeAdapterSupportInput({ blueprint }))).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    const withEnvFrom = createBlueprint({
      runtime: { envFrom: [{ kind: "secret", name: "app-env" }] },
    });
    expect(
      adapter.supports(parseRuntimeAdapterSupportInput({ blueprint: withEnvFrom })),
    ).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
  });
});

const RUNNING_STATE_JSON = '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n';

/** One `docker events --format '{{json .}}'` line for a container `die`. */
const dieEvent = (id: string, name: string, exitCode: string): string =>
  JSON.stringify({
    status: "die",
    id,
    from: "image",
    Type: "container",
    Action: "die",
    Actor: { ID: id, Attributes: { exitCode, image: "image", name } },
    scope: "local",
    time: 1,
  });

describe("DockerRuntimeAdapter runtime observation", () => {
  it("inspects containers: running, exited with the exit code and a log tail, missing", async () => {
    const commandRunner = vi.fn(async (_command: string, args: Array<string>) => {
      const id = args.at(-1);
      if (args[0] === "inspect") {
        if (id === "c-running") return { stdout: RUNNING_STATE_JSON, stderr: "" };
        if (id === "c-paused") {
          return {
            stdout: '{"Status":"paused","Running":false,"ExitCode":0,"Error":""}\n',
            stderr: "",
          };
        }
        if (id === "c-exited") {
          return {
            stdout: '{"Status":"exited","Running":false,"ExitCode":137,"Error":""}\n',
            stderr: "",
          };
        }
        throw new Error(`Error response from daemon: No such container: ${id}`);
      }
      if (args[0] === "logs") return { stdout: "last words\n", stderr: "" };
      throw new Error(`unexpected docker ${args.join(" ")}`);
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(adapter.inspect({ resourceId: "c-running" })).resolves.toEqual({
      state: "running",
      platformState: "running",
    });
    await expect(adapter.inspect({ resourceId: "c-paused" })).resolves.toEqual({
      state: "running",
      platformState: "paused",
    });
    await expect(adapter.inspect({ resourceId: "c-exited" })).resolves.toEqual({
      state: "exited",
      exitCode: 137,
      detail: "status: exited, exitCode: 137\nLogs:\nlast words",
    });
    await expect(adapter.inspect({ resourceId: "c-gone" })).resolves.toEqual({ state: "missing" });
    // Logs are read for the exited container only: the post-mortem before removal.
    expect(commandRunner.mock.calls.filter(([, args]) => args[0] === "logs")).toEqual([
      ["docker", ["logs", "--tail", "200", "c-exited"]],
    ]);
  });

  it("surfaces a daemon failure from inspect instead of guessing a state", async () => {
    const commandRunner = vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    await expect(adapter.inspect({ resourceId: "c-1" })).rejects.toThrow(/Cannot connect/);
  });

  it("reports die events for its own containers and reconnects when the stream drops", async () => {
    vi.useFakeTimers();
    try {
      interface FakeStream {
        readonly args: readonly string[];
        readonly onLine: (line: string) => void;
        readonly onEnd: (error: unknown) => void;
        killed: boolean;
      }
      const streams: FakeStream[] = [];
      const adapter = new DockerRuntimeAdapter({
        commandRunner: vi.fn(async () => ({ stdout: "", stderr: "" })),
        runtimeCatalogLoader: createRuntimeCatalogLoader(),
        eventStreamOpener: ({ args, onLine, onEnd }) => {
          const stream: FakeStream = { args, onLine, onEnd, killed: false };
          streams.push(stream);
          return {
            kill: () => {
              stream.killed = true;
            },
          };
        },
      });
      const onExit = vi.fn();
      const onError = vi.fn();

      const watch = adapter.watchExits({ onExit, onError });

      expect(streams).toHaveLength(1);
      expect(streams[0]?.args).toEqual([
        "events",
        "--filter",
        "type=container",
        "--filter",
        "event=die",
        "--format",
        "{{json .}}",
      ]);

      streams[0]?.onLine(dieEvent("aaa", "sealant-run-1", "137"));
      // Not ours (another prefix), not an exit, not JSON: ignored, never thrown.
      streams[0]?.onLine(dieEvent("bbb", "other-run-1", "1"));
      streams[0]?.onLine(
        JSON.stringify({
          Type: "container",
          Action: "start",
          Actor: { ID: "ccc", Attributes: { name: "sealant-run-2" } },
        }),
      );
      streams[0]?.onLine("not json");
      expect(onExit.mock.calls).toEqual([
        [{ resourceId: "aaa", result: { state: "exited", exitCode: 137 } }],
      ]);

      // The stream drops with an error: reported, then reopened after the backoff.
      streams[0]?.onEnd(new Error("daemon went away"));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(streams).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(streams).toHaveLength(2);
      streams[1]?.onLine(dieEvent("ddd", "sealant-run-3", "0"));
      expect(onExit).toHaveBeenLastCalledWith({
        resourceId: "ddd",
        result: { state: "exited", exitCode: 0 },
      });

      // Closing kills the stream and stops the reconnect loop for good.
      watch.close();
      expect(streams[1]?.killed).toBe(true);
      streams[1]?.onEnd(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(streams).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
