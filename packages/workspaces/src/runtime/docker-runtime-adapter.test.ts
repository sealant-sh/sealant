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
        workspace: {
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

describe("DockerRuntimeAdapter", () => {
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
      "/workspace/repo",
    ]);
    expect(args).not.toContain("--rm");
    expect(args).toContain("127.0.0.1:5000/sealant/workspaces/demo@sha256:test");
    expect(args).toContain("NODE_ENV=development");
    expect(args).toContain("SEALANT_WORKSPACE_REPO_URL=https://github.com/example/repo.git");
    expect(args).toContain("SEALANT_WORKSPACE_REPO_REF=main");
    expect(args).toContain("SEALANT_OCI_RUNTIME=runc");
    expect(result.adapter).toBe("docker");
    expect(result.resourceId).toBe("container-id-123");
    expect(result.status).toBe("ready");
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
          workingDirectory: "/workspace/repo",
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
            workingDirectory: "/workspace/repo",
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

  it("stops a workspace container with docker rm -f", async () => {
    const commandRunner = vi.fn<
      (command: string, args: Array<string>) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "container-id-123\n", stderr: "" }));
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: createRuntimeCatalogLoader(),
    });

    const result = await adapter.stop({
      resourceId: "container-id-123",
      reference: "sealant-run-abc",
    });

    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner).toHaveBeenCalledWith("docker", ["rm", "-f", "container-id-123"]);
    expect(result).toEqual({
      adapter: "docker",
      resourceId: "container-id-123",
      outcome: "stopped",
    });
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
});
