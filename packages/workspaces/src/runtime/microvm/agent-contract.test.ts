import { describe, expect, it } from "vitest";

import {
  agentHealthResponseSchema,
  agentLaunchRequestSchema,
  DOCKER_AGENT_CONTRACT_VERSION,
  DOCKER_SOCKET_PATH,
  runHookPayloadSchema,
} from "./agent-contract.js";

const runFields = {
  runId: "run-1",
  launchSecret: "a".repeat(64),
};

const launchFields = {
  runId: "run-1",
  controlToken: "control-token",
  flushTimeoutMs: 50_000,
  bootEnv: {},
};

describe("MicroVM agent contract", () => {
  it("keeps the v1 non-Docker wire shapes unchanged", () => {
    expect(runHookPayloadSchema.parse({ version: 1, ...runFields })).toEqual({
      version: 1,
      ...runFields,
    });
    expect(agentLaunchRequestSchema.parse({ version: 1, ...launchFields })).toEqual({
      version: 1,
      ...launchFields,
    });
    expect(agentHealthResponseSchema.parse({ booted: true, controlSocket: true })).toEqual({
      booted: true,
      controlSocket: true,
    });
  });

  it("carries a bounded tail of the daemon's output with its exit, and still reads an exit without one", () => {
    const exit = { code: 1, signal: null };
    expect(
      agentHealthResponseSchema.parse({ booted: true, controlSocket: false, daemonExit: exit }),
    ).toEqual({ booted: true, controlSocket: false, daemonExit: exit });
    const withOutput = { ...exit, output: "dotfiles: stow failed" };
    expect(
      agentHealthResponseSchema.parse({
        booted: true,
        controlSocket: false,
        daemonExit: withOutput,
      }),
    ).toEqual({ booted: true, controlSocket: false, daemonExit: withOutput });
    expect(
      agentHealthResponseSchema.safeParse({
        booted: true,
        controlSocket: false,
        daemonExit: { ...exit, output: "x".repeat(4097) },
      }).success,
    ).toBe(false);
  });

  it("requires Docker explicitly in both v2 launch phases", () => {
    const services = { docker: "required" } as const;
    expect(
      runHookPayloadSchema.parse({
        version: DOCKER_AGENT_CONTRACT_VERSION,
        ...runFields,
        services,
      }),
    ).toEqual({ version: 2, ...runFields, services });
    expect(
      agentLaunchRequestSchema.parse({
        version: DOCKER_AGENT_CONTRACT_VERSION,
        ...launchFields,
        services,
      }),
    ).toEqual({ version: 2, ...launchFields, services });
    expect(() =>
      runHookPayloadSchema.parse({ version: DOCKER_AGENT_CONTRACT_VERSION, ...runFields }),
    ).toThrow();
    expect(() =>
      agentLaunchRequestSchema.parse({ version: 1, ...launchFields, services }),
    ).toThrow();
  });

  it("accepts only bounded Docker lifecycle states in v2 health", () => {
    const base = {
      version: DOCKER_AGENT_CONTRACT_VERSION,
      booted: true,
      controlSocket: false,
    } as const;
    expect(
      agentHealthResponseSchema.parse({
        ...base,
        services: { docker: { status: "starting" } },
      }),
    ).toEqual({ ...base, services: { docker: { status: "starting" } } });
    expect(
      agentHealthResponseSchema.parse({
        ...base,
        controlSocket: true,
        services: { docker: { status: "ready", socket: DOCKER_SOCKET_PATH } },
      }),
    ).toMatchObject({ services: { docker: { status: "ready" } } });
    expect(
      agentHealthResponseSchema.parse({
        ...base,
        services: {
          docker: {
            status: "failed",
            reason: "probe-failed",
            code: null,
            signal: null,
            probe: { reason: "spawn-failed", code: "ENOENT", signal: null },
          },
        },
      }),
    ).toMatchObject({
      services: {
        docker: {
          status: "failed",
          reason: "probe-failed",
          probe: { reason: "spawn-failed", code: "ENOENT" },
        },
      },
    });
    expect(
      agentHealthResponseSchema.parse({
        ...base,
        services: {
          docker: {
            status: "failed",
            reason: "directory-preparation-failed",
            code: null,
            signal: null,
          },
        },
      }),
    ).toMatchObject({
      services: { docker: { status: "failed", reason: "directory-preparation-failed" } },
    });
    // A failure may say what the engine is made of and the failing command's last output, bounded
    // (sealant redacts it before it enters a diagnostic); never an unbounded daemon log.
    const failedWith = (output: string) => ({
      ...base,
      services: {
        docker: {
          status: "failed",
          reason: "container-probe-failed",
          code: null,
          signal: null,
          output,
        },
      },
    });
    expect(
      agentHealthResponseSchema.parse(failedWith("containerd: /usr/local/bin/containerd v2")),
    ).toMatchObject({
      services: { docker: { reason: "container-probe-failed" } },
    });
    expect(() => agentHealthResponseSchema.parse(failedWith("x".repeat(4097)))).toThrow();
  });
});
