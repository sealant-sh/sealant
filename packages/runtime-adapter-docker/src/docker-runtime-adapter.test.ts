import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
} from "@sealant/runtime-adapters-api";

import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";

const createBlueprint = (overrides: Record<string, unknown> = {}) => {
  return parseRuntimeAdapterSupportInput({
    blueprint: {
      access: {
        ssh: {
          enabled: false,
        },
      },
      runtime: {
        env: {},
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        network: {
          outbound: true,
        },
      },
      target: {
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
      ...overrides,
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

describe("DockerRuntimeAdapter", () => {
  it("supports SSH-enabled blueprints when key source is configured", () => {
    const adapter = new DockerRuntimeAdapter();
    const support = adapter.supports({
      blueprint: createBlueprint({
        access: {
          ssh: {
            enabled: true,
            listenPort: 2222,
            authorizedKeysRef: "/workspace/.secrets/authorized_keys",
          },
        },
      }),
    });

    expect(support).toEqual({ supported: true });
  });

  it("rejects SSH-enabled blueprints when no key source is configured", () => {
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

    expect(support).toEqual({
      supported: false,
      reason: "unsupported-access-mode",
      message:
        "SSH is enabled but no authorized keys file was provided in access.ssh.authorizedKeysRef or adapter defaults.",
    });
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
          network: {
            outbound: true,
          },
        },
      }),
    );

    expect(commandRunner).toHaveBeenCalledTimes(2);
    const firstCall = commandRunner.mock.calls[0];
    const command = firstCall?.[0];
    const args = firstCall?.[1];
    expect(command).toBe("docker");
    expect(args).toBeDefined();
    expect(args?.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      expect.any(String),
      "-w",
      "/workspace/repo",
    ]);
    expect(args).not.toContain("--rm");
    expect(args).toContain("127.0.0.1:5000/sealant/workspaces/demo@sha256:test");
    expect(args).toContain("NODE_ENV=development");
    expect(result.adapter).toBe("docker");
    expect(result.resourceId).toBe("container-id-123");
    expect(result.status).toBe("running");
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
    });

    await expect(adapter.launch(createLaunchInput())).rejects.toThrow(
      "exited immediately (status: exited, exitCode: 127, error: exec failed)",
    );
  });

  it("publishes SSH port and endpoint when SSH is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sealant-keys-"));
    const keyFile = join(tempDir, "authorized_keys");
    await writeFile(keyFile, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKexamplekey user@example\n", "utf8");

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

      if (args[0] === "port") {
        return {
          stdout: "127.0.0.1:49153\n",
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
      defaultSshAuthorizedKeysFile: keyFile,
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
      expect(runArgs).toContain("-p");
      expect(runArgs).toContain("127.0.0.1::2222");
      expect(runArgs).toContain("SEALANT_ENABLE_SSH=true");
      expect(runArgs.some((arg) => arg.startsWith("SEALANT_SSH_AUTHORIZED_KEYS_BASE64="))).toBe(true);
      expect(result.endpoint).toBe("ssh://root@127.0.0.1:49153");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
