import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SOCKET_PATH,
  parseSandboxIdFromUsername,
  toControlTarget,
  type SandboxSshTarget,
} from "./sandbox-target.js";

describe("parseSandboxIdFromUsername", () => {
  it("extracts sandbox id from prefixed usernames", () => {
    expect(parseSandboxIdFromUsername("sbx-sandbox_123", "sbx")).toBe("sandbox_123");
  });

  it("rejects usernames that do not match the configured prefix", () => {
    expect(parseSandboxIdFromUsername("sandbox_123", "sbx")).toBeUndefined();
  });

  it("rejects invalid sandbox identifiers", () => {
    expect(parseSandboxIdFromUsername("sbx-../../etc/passwd", "sbx")).toBeUndefined();
  });
});

const dockerTarget = (resourceId: string): SandboxSshTarget => ({
  sandboxId: "sandbox_123",
  attemptId: "attempt_456",
  runtime: {
    adapter: "docker",
    resourceId,
    reference: "sealant-sandbox_123",
    status: "running",
    endpoint: "control://docker-exec",
  },
});

describe("toControlTarget", () => {
  it("maps a docker runtime to a docker-exec control target", () => {
    expect(toControlTarget(dockerTarget("ctr-abc"))).toEqual({
      kind: "docker-exec",
      containerId: "ctr-abc",
      socketPath: DEFAULT_CONTROL_SOCKET_PATH,
    });
  });

  it("maps a unix:// endpoint to a direct unix-socket target (§2.2 — no Docker)", () => {
    const target: SandboxSshTarget = {
      ...dockerTarget("ctr-abc"),
      runtime: {
        ...dockerTarget("ctr-abc").runtime,
        endpoint: "unix:///run/sealant/sockets/sealant-sandbox_123/control.sock",
      },
    };
    expect(toControlTarget(target)).toEqual({
      kind: "unix-socket",
      socketPath: "/run/sealant/sockets/sealant-sandbox_123/control.sock",
    });
  });

  it("falls back to docker-exec for a docker-exec:// endpoint", () => {
    const target: SandboxSshTarget = {
      ...dockerTarget("ctr-xyz"),
      runtime: {
        ...dockerTarget("ctr-xyz").runtime,
        endpoint: "docker-exec://ctr-xyz/run/sealant/control.sock",
      },
    };
    expect(toControlTarget(target)).toEqual({
      kind: "docker-exec",
      containerId: "ctr-xyz",
      socketPath: DEFAULT_CONTROL_SOCKET_PATH,
    });
  });

  it("rejects non-docker adapters", () => {
    const target: SandboxSshTarget = {
      ...dockerTarget("ctr-abc"),
      runtime: { ...dockerTarget("ctr-abc").runtime, adapter: "k8s" },
    };
    expect(() => toControlTarget(target)).toThrow("Unsupported runtime adapter");
  });
});
