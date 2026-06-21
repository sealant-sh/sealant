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

  it("rejects non-docker adapters", () => {
    const target: SandboxSshTarget = {
      ...dockerTarget("ctr-abc"),
      runtime: { ...dockerTarget("ctr-abc").runtime, adapter: "k8s" },
    };
    expect(() => toControlTarget(target)).toThrow("Unsupported runtime adapter");
  });
});
