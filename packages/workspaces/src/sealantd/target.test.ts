/**
 * Docker-free unit coverage for the P6 target-derivation seam. Pins the pure mapping from the
 * existing Docker runtime path (container id / persisted runtime instance) onto the `SealantTarget`
 * shape that `SealantRuntime.connect` consumes. No Docker, no network, no DB — runs in the default
 * `*.test.ts` unit suite.
 */
import type { WorkspaceRuntimeInstance } from "@sealant/db";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SOCKET_PATH,
  describeUnaddressableRuntimeInstance,
  sealantTargetForDockerContainer,
  sealantTargetForRuntimeInstance,
} from "./target.js";

/** Builds a runtime-instance row with sane defaults; override only the fields under test. */
const runtimeInstance = (
  overrides: Partial<WorkspaceRuntimeInstance> = {},
): WorkspaceRuntimeInstance => ({
  runId: "run_test",
  status: "running",
  adapter: "docker",
  resourceId: "container-abc123",
  reference: "sealant-workspace-latest-xyz",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: new Date("2026-06-21T00:00:00.000Z"),
  finishedAt: null,
  createdAt: new Date("2026-06-21T00:00:00.000Z"),
  updatedAt: new Date("2026-06-21T00:00:00.000Z"),
  ...overrides,
});

describe("sealantTargetForDockerContainer", () => {
  it("maps a container id onto a docker-exec target with the default control socket", () => {
    expect(sealantTargetForDockerContainer("container-abc123")).toEqual({
      kind: "docker-exec",
      containerId: "container-abc123",
      socketPath: DEFAULT_CONTROL_SOCKET_PATH,
    });
  });

  it("honors an explicit socket path override", () => {
    expect(sealantTargetForDockerContainer("ctr", "/tmp/custom.sock")).toEqual({
      kind: "docker-exec",
      containerId: "ctr",
      socketPath: "/tmp/custom.sock",
    });
  });

  it("defaults the socket to the entrypoint's /run/sealant/control.sock", () => {
    expect(DEFAULT_CONTROL_SOCKET_PATH).toBe("/run/sealant/control.sock");
  });
});

describe("sealantTargetForRuntimeInstance", () => {
  it("uses the persisted Unix control endpoint when the runtime exposes one", () => {
    const target = sealantTargetForRuntimeInstance(
      runtimeInstance({ endpoint: "unix:///run/sealant/sockets/workspace-123/control.sock" }),
    );

    expect(target).toEqual({
      kind: "unix-socket",
      socketPath: "/run/sealant/sockets/workspace-123/control.sock",
    });
  });

  it("derives a target from a running docker instance using its resourceId", () => {
    const target = sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "ctr-running" }));

    expect(target).toEqual({
      kind: "docker-exec",
      containerId: "ctr-running",
      socketPath: DEFAULT_CONTROL_SOCKET_PATH,
    });
  });

  it("threads a custom socket path through to the derived target", () => {
    const target = sealantTargetForRuntimeInstance(
      runtimeInstance({ resourceId: "ctr" }),
      "/var/lib/sealant.sock",
    );

    expect(target?.kind === "docker-exec" ? target.socketPath : undefined).toBe(
      "/var/lib/sealant.sock",
    );
  });

  it("accepts the socket path through the options object too", () => {
    const target = sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "ctr" }), {
      socketPath: "/var/lib/sealant.sock",
    });

    expect(target).toEqual({
      kind: "docker-exec",
      containerId: "ctr",
      socketPath: "/var/lib/sealant.sock",
    });
  });

  const websocketTls = {
    caPath: "/etc/sealant/tls/ca.crt",
    certPath: "/etc/sealant/tls/tls.crt",
    keyPath: "/etc/sealant/tls/tls.key",
  };

  it("derives a websocket target for a Kubernetes instance with a wss endpoint and client TLS", () => {
    for (const adapter of ["k8s", "k3s"] as const) {
      const target = sealantTargetForRuntimeInstance(
        runtimeInstance({
          adapter,
          resourceId: "ws-run-abc",
          endpoint: "wss://ws-run-abc.sealant-workspaces.svc:7443/control",
        }),
        { websocketTls },
      );
      expect(target).toEqual({
        kind: "websocket",
        url: "wss://ws-run-abc.sealant-workspaces.svc:7443/control",
        tls: websocketTls,
      });
    }
  });

  it("returns undefined for a Kubernetes instance without client TLS material", () => {
    expect(
      sealantTargetForRuntimeInstance(
        runtimeInstance({ adapter: "k8s", endpoint: "wss://ws.svc:7443/control" }),
      ),
    ).toBeUndefined();
    expect(describeUnaddressableRuntimeInstance(runtimeInstance({ adapter: "k8s" }))).toContain(
      "SEALANT_CONTROL_CLIENT_CERT_PATH",
    );
  });

  it("returns undefined for a Kubernetes instance whose endpoint is not wss://", () => {
    expect(
      sealantTargetForRuntimeInstance(
        runtimeInstance({ adapter: "k8s", endpoint: "docker-exec://ctr/run/sealant/control.sock" }),
        { websocketTls },
      ),
    ).toBeUndefined();
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ adapter: "k3s", endpoint: null }), {
        websocketTls,
      }),
    ).toBeUndefined();
  });

  it("never lets client TLS material turn a docker instance into a websocket target", () => {
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "ctr" }), { websocketTls }),
    ).toEqual({ kind: "docker-exec", containerId: "ctr", socketPath: DEFAULT_CONTROL_SOCKET_PATH });
  });

  it("returns undefined when the adapter has not been recorded yet", () => {
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ adapter: null }))).toBeUndefined();
  });

  it("returns undefined for a pending instance with no resourceId", () => {
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ status: "pending", resourceId: null })),
    ).toBeUndefined();
  });

  it("returns undefined for an empty resourceId", () => {
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "" }))).toBeUndefined();
  });
});

describe("sealantTargetForRuntimeInstance (cloudflare)", () => {
  const endpoint = "wss://bridge.example.com/workspaces/ws-1/control";

  it("derives a bearer-token websocket target from a wss endpoint plus the configured token", () => {
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ adapter: "cloudflare", endpoint }), {
        controlBearerToken: "token-123",
      }),
    ).toEqual({ kind: "websocket", url: endpoint, auth: { bearerToken: "token-123" } });
  });

  it("yields no target without the bearer token, and says which env is missing", () => {
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ adapter: "cloudflare", endpoint })),
    ).toBeUndefined();
    expect(
      describeUnaddressableRuntimeInstance(runtimeInstance({ adapter: "cloudflare", endpoint })),
    ).toContain("SEALANT_CONTROL_BEARER_TOKEN");
  });

  it("yields no target for a non-wss endpoint", () => {
    expect(
      sealantTargetForRuntimeInstance(
        runtimeInstance({ adapter: "cloudflare", endpoint: "https://bridge.example.com" }),
        { controlBearerToken: "token-123" },
      ),
    ).toBeUndefined();
    expect(
      describeUnaddressableRuntimeInstance(
        runtimeInstance({ adapter: "cloudflare", endpoint: null }),
        { controlBearerToken: "token-123" },
      ),
    ).toContain("no wss:// endpoint");
  });

  it("never lets a bearer token change how a docker instance is reached", () => {
    expect(
      sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "ctr" }), {
        controlBearerToken: "token-123",
      }),
    ).toEqual({ kind: "docker-exec", containerId: "ctr", socketPath: DEFAULT_CONTROL_SOCKET_PATH });
  });
});
