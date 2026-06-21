/**
 * Docker-free unit coverage for the P6 target-derivation seam. Pins the pure mapping from the
 * existing Docker runtime path (container id / persisted runtime instance) onto the `SealantTarget`
 * shape that `SealantRuntime.connect` consumes. No Docker, no network, no DB — runs in the default
 * `*.test.ts` unit suite.
 */
import type { SandboxRuntimeInstance } from "@sealant/db";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SOCKET_PATH,
  sealantTargetForDockerContainer,
  sealantTargetForRuntimeInstance,
} from "./target.js";

/** Builds a runtime-instance row with sane defaults; override only the fields under test. */
const runtimeInstance = (
  overrides: Partial<SandboxRuntimeInstance> = {},
): SandboxRuntimeInstance => ({
  runId: "run_test",
  status: "running",
  adapter: "docker",
  resourceId: "container-abc123",
  reference: "sealant-sandbox-latest-xyz",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
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
  it("derives a target from a running docker instance using its resourceId", () => {
    const target = sealantTargetForRuntimeInstance(
      runtimeInstance({ resourceId: "ctr-running" }),
    );

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

    expect(target?.socketPath).toBe("/var/lib/sealant.sock");
  });

  it("returns undefined for a non-docker adapter (no docker-exec transport for k8s yet)", () => {
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ adapter: "k8s" }))).toBeUndefined();
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ adapter: "k3s" }))).toBeUndefined();
  });

  it("returns undefined when the adapter has not been recorded yet", () => {
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ adapter: null }))).toBeUndefined();
  });

  it("returns undefined for a pending instance with no resourceId", () => {
    expect(
      sealantTargetForRuntimeInstance(
        runtimeInstance({ status: "pending", resourceId: null }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an empty resourceId", () => {
    expect(sealantTargetForRuntimeInstance(runtimeInstance({ resourceId: "" }))).toBeUndefined();
  });
});
