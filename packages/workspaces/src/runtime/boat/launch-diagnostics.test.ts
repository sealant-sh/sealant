import { describe, expect, it } from "vitest";

import { BoatAllocationError } from "./allocation.js";
import { BoatApiError } from "./config.js";
import { boatGuestOutput, boatLaunchDiagnostic, boatLaunchSummary } from "./launch-diagnostics.js";

describe("Boat launch diagnostics", () => {
  it("preserves the agent operation, fixed route, reason and redacted body across launch wrappers", () => {
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "agent-request",
          errorClass: "BoatExecutionError",
          code: "agent-refused",
          provider: { operation: "agent-recover", status: 409, causeClass: null },
          agent: {
            pathClass: "/sealant/recover",
            responseTail: "token=hidden-value recover-new-boot",
            reason: "recover-new-boot",
          },
        },
      },
      "prepare-launch",
    );
    const wrapper = new BoatAllocationError("provider-unavailable", diagnostic);
    expect(boatLaunchDiagnostic(new Error("outer", { cause: wrapper }), "readiness")).toEqual(
      diagnostic,
    );
    expect(wrapper.message).toContain("agent-recover");
    expect(wrapper.message).toContain('"reason":"recover-new-boot"');
    expect(wrapper.message).not.toContain("hidden-value");
  });
  it("keeps what the agent's health said of the guest, never an unlisted message", () => {
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "readiness",
          errorClass: "BoatExecutionError",
          code: "guest-failed",
          guest: { service: "docker", exitCode: 1, reason: "readiness-timeout" },
          message: "Bearer hidden-value",
        },
      },
      "readiness",
    );
    expect(diagnostic).toEqual({
      step: "readiness",
      errorClass: "BoatExecutionError",
      code: "guest-failed",
      guest: { service: "docker", exitCode: 1, reason: "readiness-timeout" },
    });
    expect(boatLaunchSummary(diagnostic)).not.toContain("hidden-value");
  });
  it("carries the last lines sealantd printed, bounded, with its secrets and URL paths removed", () => {
    const output = [
      ...Array.from({ length: 40 }, (_, line) => `INFO preparing step ${String(line)}`),
      "token=mst_live_value and Bearer hidden-bearer",
      "ERROR capture plan.get to https://user:pw@mend.example.com:8443/session/s1?sig=presigned-secret failed",
      "sealantd boot: the capture worktree could not be materialized: launch-secret-value refused",
    ].join("\n");
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "readiness",
          errorClass: "BoatExecutionError",
          code: "guest-failed",
          guest: {
            service: "sealantd",
            exitCode: 1,
            outputTail: boatGuestOutput(`\u001b[31m${output}\u0007`, ["launch-secret-value"]),
          },
        },
      },
      "readiness",
    );
    const tail = diagnostic.guest?.outputTail ?? "";
    expect(tail.split("\n")).toHaveLength(20);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(2048);
    expect(tail).not.toContain("INFO preparing step 22\n");
    expect(tail).toContain("[url https mend.example.com:8443]");
    expect(tail.endsWith("could not be materialized: [REDACTED] refused")).toBe(true);
    const summary = boatLaunchSummary(diagnostic);
    expect(summary).toContain("could not be materialized");
    for (const forbidden of [
      "mst_live_value",
      "hidden-bearer",
      "presigned-secret",
      "/session/s1",
      "user:pw",
      "launch-secret-value",
      "\u001b",
    ])
      expect(summary).not.toContain(forbidden);
  });
  it("bounds the output tail however it is reached, even past an untrusted wrapper", () => {
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "readiness",
          errorClass: "BoatExecutionError",
          code: "guest-failed",
          guest: { service: "sealantd", exitCode: 1, outputTail: `${"é".repeat(5000)}\nlast` },
        },
      },
      "readiness",
    );
    expect(Buffer.byteLength(diagnostic.guest?.outputTail ?? "")).toBeLessThanOrEqual(2048);
    expect(diagnostic.guest?.outputTail?.endsWith("\nlast")).toBe(true);
  });
  it("bounds and redacts command tails across worker and runtime wrappers", () => {
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "bind-exchange",
          errorClass: "BoatExecutionError",
          command: {
            exitCode: 1,
            timedOut: false,
            stdoutTail: "a".repeat(10000) + " secret=do-not-record-me",
            stderrTail: "Bearer hidden-value\nhttps://secret.invalid/path\nbind-manifest-mismatch",
          },
        },
      },
      "prepare-launch",
    );
    expect(Buffer.byteLength(diagnostic.command?.stdoutTail ?? "")).toBeLessThanOrEqual(4096);
    expect(boatLaunchSummary(diagnostic)).toContain("bind-manifest-mismatch");
    for (const forbidden of ["hidden-value", "secret.invalid", "do-not-record-me"])
      expect(boatLaunchSummary(diagnostic)).not.toContain(forbidden);
  });
  it("retains a provider's class, step, operation, status and classified transport cause across wrappers", () => {
    const original = new BoatApiError(
      "execute",
      503,
      "transport_error",
      new Error("Bearer secret-credential", { cause: { code: "UND_ERR_SOCKET" } }),
    );
    const diagnostic = boatLaunchDiagnostic(original, "read-boot-id");
    expect(boatLaunchDiagnostic(new Error("wrapper", { cause: original }), "read-boot-id")).toEqual(
      diagnostic,
    );
    const wrapper = new BoatAllocationError("provider-unavailable", diagnostic);
    expect(
      boatLaunchDiagnostic(new Error("outer", { cause: wrapper }), "prepare-allocation"),
    ).toEqual({
      step: "read-boot-id",
      errorClass: "BoatApiError",
      provider: { operation: "execute", status: 503, causeClass: "UND_ERR_SOCKET" },
    });
    expect(wrapper.message).toContain(boatLaunchSummary(diagnostic));
    expect(wrapper.message).not.toContain("secret-credential");
  });
  it("discards arbitrary messages, unknown classes, extra diagnostic fields and secret-bearing operations", () => {
    const error = Object.assign(new Error("secret-credential"), {
      name: "secret-credential",
      diagnostic: { step: "read-boot-id", errorClass: "Error", secret: "secret-credential" },
    });
    expect(JSON.stringify(boatLaunchDiagnostic(error, "prepare-launch"))).not.toContain(
      "secret-credential",
    );
    expect(
      boatLaunchDiagnostic(
        new BoatApiError("secret-credential", 401, "secret-credential"),
        "read-source",
      ),
    ).toEqual({
      step: "read-source",
      errorClass: "BoatApiError",
      provider: { operation: "unknown", status: 401, causeClass: null },
    });
  });
});
