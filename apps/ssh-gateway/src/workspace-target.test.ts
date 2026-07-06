import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SOCKET_PATH,
  parseWorkspaceIdFromUsername,
  toControlTarget,
  type WorkspaceSshTarget,
} from "./workspace-target.js";

describe("parseWorkspaceIdFromUsername", () => {
  it("extracts workspace id from prefixed usernames", () => {
    expect(parseWorkspaceIdFromUsername("ws-workspace_123", "ws")).toBe("workspace_123");
  });

  it("rejects usernames that do not match the configured prefix", () => {
    expect(parseWorkspaceIdFromUsername("workspace_123", "ws")).toBeUndefined();
  });

  it("rejects invalid workspace identifiers", () => {
    expect(parseWorkspaceIdFromUsername("ws-../../etc/passwd", "ws")).toBeUndefined();
  });
});

const dockerTarget = (resourceId: string): WorkspaceSshTarget => ({
  workspaceId: "workspace_123",
  attemptId: "attempt_456",
  runtime: {
    adapter: "docker",
    resourceId,
    reference: "sealant-workspace_123",
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
    const target: WorkspaceSshTarget = {
      ...dockerTarget("ctr-abc"),
      runtime: {
        ...dockerTarget("ctr-abc").runtime,
        endpoint: "unix:///run/sealant/sockets/sealant-workspace_123/control.sock",
      },
    };
    expect(toControlTarget(target)).toEqual({
      kind: "unix-socket",
      socketPath: "/run/sealant/sockets/sealant-workspace_123/control.sock",
    });
  });

  it("falls back to docker-exec for a docker-exec:// endpoint", () => {
    const target: WorkspaceSshTarget = {
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
    const target: WorkspaceSshTarget = {
      ...dockerTarget("ctr-abc"),
      runtime: { ...dockerTarget("ctr-abc").runtime, adapter: "k8s" },
    };
    expect(() => toControlTarget(target)).toThrow("Unsupported runtime adapter");
  });
});
