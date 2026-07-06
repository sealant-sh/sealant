import { describe, expect, it } from "vitest";

import { attributeBatch, collectExecutionIds } from "./attribution.js";
import type { NormalizedEvent } from "./types.js";

const event = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: "evt_1",
  runtimeId: "rt_1",
  executionId: undefined,
  sessionId: undefined,
  processId: undefined,
  requestId: undefined,
  schemaVersion: 0,
  sequence: 1n,
  observedAt: 0n,
  monotonicTimestamp: 0n,
  captureMethod: 0,
  confidence: 0,
  payloadCase: "ioChunk",
  payload: {},
  summary: "",
  content: undefined,
  scrollback: undefined,
  ...overrides,
});

describe("collectExecutionIds", () => {
  it("returns the distinct non-empty execution ids", () => {
    const batch = [
      event({ eventId: "a", executionId: "run_ssh" }),
      event({ eventId: "b", executionId: "run_ssh" }),
      event({ eventId: "c", executionId: "run_harness" }),
      event({ eventId: "d", executionId: undefined }),
      event({ eventId: "e", executionId: "" }),
    ];
    expect(collectExecutionIds(batch)).toEqual(new Set(["run_ssh", "run_harness"]));
  });
});

describe("attributeBatch", () => {
  it("stamps attributedRunId only for resolved execution ids", () => {
    const batch = [
      event({ eventId: "ssh", executionId: "run_ssh" }),
      event({ eventId: "boot", executionId: undefined }),
      event({ eventId: "foreign", executionId: "run_other_sandbox" }),
    ];
    const attributed = attributeBatch(batch, new Map([["run_ssh", "run_ssh"]]));

    expect(attributed[0]?.attributedRunId).toBe("run_ssh");
    // Untagged daemon events (boot, heartbeats) fall back to the connection's default run.
    expect(attributed[1]?.attributedRunId).toBeUndefined();
    // Execution ids that failed the same-sandbox check are NOT attributed.
    expect(attributed[2]?.attributedRunId).toBeUndefined();
  });

  it("leaves unresolved events untouched (same object, no copy)", () => {
    const untouched = event({ eventId: "x" });
    const [result] = attributeBatch([untouched], new Map());
    expect(result).toBe(untouched);
  });
});
