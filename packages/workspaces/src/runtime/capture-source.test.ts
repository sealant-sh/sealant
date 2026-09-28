import { describe, expect, it } from "vitest";

import { captureSourceEnv, shutdownFinalDeadlineMs } from "./capture-source.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const captureSource = (input: {
  readonly worktreeId?: string;
  readonly harnessHome?: string;
  readonly transport?: {
    readonly plaintext?: boolean;
    readonly channelCaPem?: string;
    readonly objectCaPem?: string;
  };
}) => {
  const launch = parseRuntimeAdapterLaunchInput({
    blueprint: {
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          ...input,
        },
      },
      harness: { id: "claude-code" },
    },
    publishedImage: {
      repository: "sealant/workspaces/demo",
      tag: "capture",
      reference: "registry.example.com/demo:capture",
      digestReference: "registry.example.com/demo@sha256:test",
      digest: "sha256:test",
    },
  });
  const source = launch.blueprint.sources.workspace;
  if (source.kind !== "capture") {
    throw new Error("expected capture source");
  }
  return source;
};

describe("the shutdown final flush's deadline (e2e 5)", () => {
  // e2e 5 (HS): the store was down, Core stopped the executor, and the SIGTERM final flush
  // retried for the whole 3600 s stop timeout until Docker killed it: the exit 75 that keeps and
  // recovers the disk was never reached. The deadline is the stop grace less a margin.
  it("ends inside the runtime's stop grace, leaving the daemon time to exit 75", () => {
    expect(shutdownFinalDeadlineMs(3_600_000)).toBe(3_540_000);
    expect(shutdownFinalDeadlineMs(120_000)).toBe(108_000);
    expect(shutdownFinalDeadlineMs(50_000)).toBe(45_000);
    expect(shutdownFinalDeadlineMs(15_000)).toBe(10_000);
    for (const grace of [15_000, 50_000, 120_000, 3_600_000, 86_400_000]) {
      const deadline = shutdownFinalDeadlineMs(grace) ?? 0;
      // At least 5 s before the kill, and never under the daemon's own 10 s shutdown grace.
      expect(grace - deadline).toBeGreaterThanOrEqual(5_000);
      expect(deadline).toBeGreaterThanOrEqual(10_000);
    }
    // A grace too short for both: no deadline (the flush runs until it completes, as before).
    expect(shutdownFinalDeadlineMs(14_000)).toBeUndefined();
    expect(shutdownFinalDeadlineMs(1_000)).toBeUndefined();
  });

  it("is delivered with the capture source when the runtime names its stop grace", () => {
    const env = captureSourceEnv(captureSource({ worktreeId: "wt_1" }), { stopGraceMs: 3_600_000 });
    expect(env).toContainEqual(["SEALANT_SHUTDOWN_FINAL_DEADLINE_MS", "3540000"]);
    for (const emitted of [
      captureSourceEnv(captureSource({ worktreeId: "wt_1" })),
      captureSourceEnv(captureSource({ worktreeId: "wt_1" }), { stopGraceMs: 8_000 }),
    ]) {
      expect(emitted.some(([key]) => key === "SEALANT_SHUTDOWN_FINAL_DEADLINE_MS")).toBe(false);
    }
  });
});

describe("captureSourceEnv", () => {
  it("encodes the cold capture channel, worktree and harness root", () => {
    expect(
      captureSourceEnv(
        captureSource({ worktreeId: "wt_1", harnessHome: "/workspace/harness-home" }),
      ),
    ).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_WORKTREE_ID", "wt_1"],
      ["SEALANT_CAPTURE_HARNESS_HOME", "/workspace/harness-home"],
    ]);
  });

  it("keeps the harness root for standby capture and omits only the worktree", () => {
    expect(captureSourceEnv(captureSource({ harnessHome: "/workspace/harness-home" }))).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_HARNESS_HOME", "/workspace/harness-home"],
    ]);
  });

  it("preserves the legacy environment when harnessHome is absent", () => {
    expect(captureSourceEnv(captureSource({ worktreeId: "wt_1" }))).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_WORKTREE_ID", "wt_1"],
    ]);
  });

  it("delivers no transport setting unless the launcher stated one", () => {
    const names = captureSourceEnv(captureSource({ transport: { plaintext: false } })).map(
      ([name]) => name,
    );
    expect(names.filter((name) => name.startsWith("SEALANT_CAPTURE_"))).toEqual([
      "SEALANT_CAPTURE_ENDPOINT",
    ]);
  });

  it("delivers the plaintext statement and the CA bundles the daemon verifies against", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const env = new Map(
      captureSourceEnv(
        captureSource({ transport: { plaintext: true, channelCaPem: pem, objectCaPem: pem } }),
      ),
    );
    expect(env.get("SEALANT_CAPTURE_ALLOW_PLAINTEXT")).toBe("true");
    expect(env.get("SEALANT_CAPTURE_CA_PEM")).toBe(pem);
    expect(env.get("SEALANT_CAPTURE_OBJECT_CA_PEM")).toBe(pem);
  });

  it("refuses a CA bundle that holds no certificate", () => {
    expect(() => captureSource({ transport: { channelCaPem: "not pem" } })).toThrow(
      /PEM CERTIFICATE block/,
    );
  });
});
