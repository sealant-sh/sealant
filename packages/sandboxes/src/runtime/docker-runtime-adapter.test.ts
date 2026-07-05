import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
} from "./runtime-adapter.js";

const createBlueprint = (overrides: Record<string, unknown> = {}) => {
  const base = {
    version: "1",
    sources: {
      sandbox: {
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
      sandboxRoot: "/sandbox",
      workingDirectory: "/sandbox/repo",
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
        sandbox: {
          ...base.sources.sandbox,
          ...override.sources?.sandbox,
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
      repository: "sealant/sandboxes/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
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

describe("DockerRuntimeAdapter", () => {
  it("supports SSH-enabled blueprints without any key material configured", () => {
    // The gateway reaches sandboxes over the daemon control socket; client keys are authorized
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
          workingDirectory: "/sandbox/repo",
          persistence: "ephemeral",
          ociRuntime: "runc",
          network: {
            outbound: true,
          },
        },
      }),
    );

    // `run`, a single running-state `inspect` (assertContainerRunning), then one `exec test -S`
    // control-socket readiness probe — the mock's default branch answers the probe as "accepting".
    expect(commandRunner).toHaveBeenCalledTimes(3);
    const firstCall = commandRunner.mock.calls[0];
    const command = firstCall?.[0];
    const args = firstCall?.[1];
    expect(command).toBe("docker");
    expect(args).toBeDefined();
    expect(args?.slice(0, 8)).toEqual([
      "run",
      "-d",
      "--runtime",
      "runc",
      "--name",
      expect.any(String),
      "-w",
      "/sandbox/repo",
    ]);
    expect(args).not.toContain("--rm");
    expect(args).toContain("127.0.0.1:5000/sealant/sandboxes/demo@sha256:test");
    expect(args).toContain("NODE_ENV=development");
    expect(args).toContain("SEALANT_SANDBOX_REPO_URL=https://github.com/example/repo.git");
    expect(args).toContain("SEALANT_SANDBOX_REPO_REF=main");
    expect(args).toContain("SEALANT_OCI_RUNTIME=runc");
    expect(result.adapter).toBe("docker");
    expect(result.resourceId).toBe("container-id-123");
    expect(result.status).toBe("ready");
  });

  it("waits for the control socket to accept before reporting the sandbox ready", async () => {
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
        return { stdout: "cloning sandbox repository...\n", stderr: "" };
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
          workingDirectory: "/sandbox/repo",
          persistence: "ephemeral",
          ociRuntime: "runsc",
          network: {
            outbound: true,
          },
        },
      }),
    );

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
            workingDirectory: "/sandbox/repo",
            persistence: "ephemeral",
            ociRuntime: "runsc",
            network: {
              outbound: true,
            },
          },
        }),
      ),
    ).rejects.toThrow("Docker runtime 'runsc' is not configured on this host.");
  });

  it("passes sandbox clone auth when a sandbox auth ref is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sealant-sandbox-key-"));
    const keyFile = join(tempDir, "sandbox_repo_key");
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
            sandbox: {
              url: "https://github.com/example/repo.git",
              ref: "main",
              authRef: keyFile,
            },
          },
        }),
      );

      const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
      expect(runArgs.some((arg) => arg.startsWith("SEALANT_SANDBOX_AUTH_KEY_BASE64="))).toBe(true);
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
        sandboxCloneAuth: {
          type: "http-token",
          username: "x-access-token",
          token: "github-installation-token",
        },
      }),
    );

    const runArgs = commandRunner.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("SEALANT_SANDBOX_HTTP_USERNAME=x-access-token");
    expect(runArgs).toContain("SEALANT_SANDBOX_HTTP_TOKEN=github-installation-token");
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

  it("surfaces the host socket path as the control endpoint when the bind-mount fast path is enabled", async () => {
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
              enabled: true,
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

  it("omits a control endpoint when SSH access is disabled", async () => {
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
    expect(result.endpoint).toBeUndefined();
  });
});
