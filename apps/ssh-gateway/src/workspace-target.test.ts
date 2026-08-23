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

  const websocketTls = {
    caPath: "/etc/sealant/tls/ca.crt",
    certPath: "/etc/sealant/tls/tls.crt",
    keyPath: "/etc/sealant/tls/tls.key",
  };
  const k8sTarget = (adapter: "k8s" | "k3s", endpoint: string): WorkspaceSshTarget => ({
    ...dockerTarget("ws-run-abc"),
    runtime: { ...dockerTarget("ws-run-abc").runtime, adapter, endpoint },
  });

  it("maps a Kubernetes wss endpoint onto a websocket target with the gateway's client TLS", () => {
    for (const adapter of ["k8s", "k3s"] as const) {
      expect(
        toControlTarget(k8sTarget(adapter, "wss://ws-run-abc.ns.svc:7443/control"), {
          websocketTls,
        }),
      ).toEqual({
        kind: "websocket",
        url: "wss://ws-run-abc.ns.svc:7443/control",
        tls: websocketTls,
      });
    }
  });

  it("refuses a Kubernetes target when the gateway has no client TLS material", () => {
    expect(() => toControlTarget(k8sTarget("k8s", "wss://ws-run-abc.ns.svc:7443/control"))).toThrow(
      "client TLS material",
    );
  });

  it("refuses a Kubernetes target whose endpoint is not wss://", () => {
    expect(() =>
      toControlTarget(k8sTarget("k8s", "docker-exec://ctr/run/sealant/control.sock"), {
        websocketTls,
      }),
    ).toThrow("non-wss endpoint");
  });

  it("never lets client TLS material change how a docker target is reached", () => {
    expect(toControlTarget(dockerTarget("ctr-abc"), { websocketTls })).toEqual(
      toControlTarget(dockerTarget("ctr-abc")),
    );
  });
});
