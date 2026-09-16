import { describe, expect, it } from "vitest";

import {
  matchesExpectedMicrovmDockerCandidate,
  runNestedDnsAcceptanceProbes,
  safeAgentHealthEvidence,
  safeErrorEvidence,
} from "./docker-e2e-validation.js";

describe("safeErrorEvidence", () => {
  it("retains allowlisted Docker failure fields from the typed adapter error", () => {
    expect(
      safeErrorEvidence({
        code: "microvm-guest-failed",
        phase: "docker",
        failureReason: "exited",
        guestExitCode: 1,
        guestSignal: "SIGTERM",
        message: "raw target and credentials must not be retained",
        cause: { secret: "mst_secret" },
      }),
    ).toEqual({
      classification: "typed-error",
      code: "microvm-guest-failed",
      phase: "docker",
      reason: "exited",
      exitCode: 1,
      signal: "SIGTERM",
    });
  });

  it("preserves null process results and drops unrecognized fields", () => {
    expect(
      safeErrorEvidence({
        code: "microvm-guest-failed",
        phase: "docker",
        failureReason: "attacker-controlled",
        guestExitCode: 999,
        guestSignal: "raw-log control-token",
      }),
    ).toEqual({
      classification: "typed-error",
      code: "microvm-guest-failed",
      phase: "docker",
    });
    expect(
      safeErrorEvidence({
        code: "microvm-guest-failed",
        phase: "docker",
        failureReason: "spawn-failed",
        guestExitCode: null,
        guestSignal: null,
      }),
    ).toMatchObject({ reason: "spawn-failed", exitCode: null, signal: null });
  });
});

describe("safeAgentHealthEvidence", () => {
  it("strictly retains authenticated Docker failure health", () => {
    expect(
      safeAgentHealthEvidence({
        version: 2,
        booted: false,
        controlSocket: false,
        services: {
          docker: { status: "failed", reason: "probe-failed", code: 3, signal: null },
        },
      }),
    ).toEqual({
      classification: "agent-health-docker-failed",
      phase: "docker",
      reason: "probe-failed",
      exitCode: 3,
      signal: null,
      booted: false,
      controlSocket: false,
    });
  });

  it("does not retain fields from an invalid health body", () => {
    expect(
      safeAgentHealthEvidence({
        version: 2,
        booted: false,
        controlSocket: false,
        services: {
          docker: {
            status: "failed",
            reason: "raw-log control-token",
            code: 3,
            signal: "mst_secret",
          },
        },
      }),
    ).toEqual({ classification: "agent-health-invalid" });
  });
});

describe("runNestedDnsAcceptanceProbes", () => {
  it("accepts default DNS without invoking the explicit resolver diagnostic", async () => {
    const modes: string[] = [];
    await expect(
      runNestedDnsAcceptanceProbes(async (mode) => {
        modes.push(mode);
      }),
    ).resolves.toEqual({ defaultSucceeded: true });
    expect(modes).toEqual(["default"]);
  });

  it("runs the explicit resolver only as a diagnostic and keeps default failure terminal", async () => {
    const modes: string[] = [];
    await expect(
      runNestedDnsAcceptanceProbes(async (mode) => {
        modes.push(mode);
        if (mode === "default") {
          throw new Error("default DNS failed");
        }
      }),
    ).resolves.toEqual({ defaultSucceeded: false, diagnosticSucceeded: true });
    expect(modes).toEqual(["default", "aws-resolver-diagnostic"]);
  });

  it("retains default failure when both probes fail", async () => {
    await expect(
      runNestedDnsAcceptanceProbes(async () => {
        throw new Error("DNS failed");
      }),
    ).resolves.toEqual({ defaultSucceeded: false, diagnosticSucceeded: false });
  });
});

describe("matchesExpectedMicrovmDockerCandidate", () => {
  const candidate = {
    configuredArn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker",
    configuredVersion: "17",
    expectedArn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker",
    expectedVersion: "17",
  };

  it("requires exact ARN and version equality", () => {
    expect(matchesExpectedMicrovmDockerCandidate(candidate)).toBe(true);
    expect(matchesExpectedMicrovmDockerCandidate({ ...candidate, expectedVersion: "18" })).toBe(
      false,
    );
    expect(
      matchesExpectedMicrovmDockerCandidate({
        ...candidate,
        expectedArn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:other",
      }),
    ).toBe(false);
  });
});
