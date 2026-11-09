import { describe, expect, it } from "vitest";

import { BoatAllocationError } from "./allocation.js";
import { BoatApiError } from "./config.js";
import { boatLaunchDiagnostic, boatLaunchSummary } from "./launch-diagnostics.js";

describe("Boat launch diagnostics", () => {
  it("preserves the receiver operation, fixed path and redacted body across launch wrappers", () => {
    const diagnostic = boatLaunchDiagnostic(
      {
        diagnostic: {
          step: "receiver-request",
          errorClass: "BoatExecutionError",
          provider: { operation: "receiver-status", status: 503, causeClass: null },
          receiver: {
            pathClass: "/sealant/bootstrap/status",
            responseTail: "token=hidden-value receiver-unavailable",
          },
        },
      },
      "prepare-launch",
    );
    const wrapper = new BoatAllocationError("provider-unavailable", diagnostic);
    expect(boatLaunchDiagnostic(new Error("outer", { cause: wrapper }), "readiness")).toEqual(
      diagnostic,
    );
    expect(wrapper.message).toContain("receiver-status");
    expect(wrapper.message).toContain("receiver-unavailable");
    expect(wrapper.message).not.toContain("hidden-value");
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
            stderrTail:
              "Bearer hidden-value\nhttps://secret.invalid/path\nValueError: guard-refused",
          },
        },
      },
      "prepare-launch",
    );
    expect(Buffer.byteLength(diagnostic.command?.stdoutTail ?? "")).toBeLessThanOrEqual(4096);
    expect(boatLaunchSummary(diagnostic)).toContain("guard-refused");
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
