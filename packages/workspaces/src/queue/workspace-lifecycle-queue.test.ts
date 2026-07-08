/**
 * Unit tests for the workspace-lifecycle message codec — stop requests must round-trip and
 * malformed messages must be rejected before they reach the worker (a bad message dead-letters
 * instead of poisoning the consumer).
 */
import { describe, expect, it } from "vitest";

import {
  parseWorkspaceStopRequestedMessage,
  workspaceStopRequestedMessageKind,
} from "./workspace-lifecycle-queue.js";

const base = {
  kind: workspaceStopRequestedMessageKind,
  workspaceId: "ws_1",
  runId: "run_1",
  stopReason: "user",
};

describe("parseWorkspaceStopRequestedMessage", () => {
  it("round-trips a stop request for each reason", () => {
    for (const stopReason of ["user", "expired", "failed"] as const) {
      expect(parseWorkspaceStopRequestedMessage({ ...base, stopReason })).toEqual({
        ...base,
        stopReason,
      });
    }
  });

  it("rejects an unexpected kind", () => {
    expect(() =>
      parseWorkspaceStopRequestedMessage({ ...base, kind: "workspace.start.requested" }),
    ).toThrow(/unexpected kind/);
  });

  it("rejects a missing workspaceId or runId", () => {
    expect(() => parseWorkspaceStopRequestedMessage({ ...base, workspaceId: "" })).toThrow(
      /missing workspaceId/,
    );
    expect(() => parseWorkspaceStopRequestedMessage({ ...base, runId: undefined })).toThrow(
      /missing runId/,
    );
  });

  it("rejects an unknown stop reason", () => {
    expect(() => parseWorkspaceStopRequestedMessage({ ...base, stopReason: "because" })).toThrow(
      /unexpected stopReason/,
    );
  });
});
