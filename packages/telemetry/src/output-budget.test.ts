import { describe, expect, it } from "vitest";

import { applyOutputBudget, makeOutputBudgetState } from "./output-budget.js";
import type { NormalizedEvent } from "./types.js";

const chunk = (sequence: bigint, size: number): NormalizedEvent => ({
  eventId: `evt_${sequence}`,
  runtimeId: "rt_1",
  executionId: "",
  sessionId: "",
  processId: "proc_1",
  requestId: "",
  schemaVersion: 1,
  sequence,
  observedAt: 0n,
  monotonicTimestamp: 0n,
  captureMethod: 0,
  confidence: 0,
  payloadCase: "ioChunk",
  payload: {},
  summary: "",
  content: {
    algo: "sha256",
    hash: `h${sequence}`,
    byteSize: BigInt(size),
    bytes: new Uint8Array(size),
  },
  scrollback: {
    processId: "proc_1",
    sessionId: undefined,
    stream: 1,
    streamOffset: 0n,
    byteCount: BigInt(size),
    contentAlgo: "sha256",
    contentHash: `h${sequence}`,
    redacted: false,
    truncated: false,
    coalesced: false,
    originalByteCount: undefined,
  },
});

const marker = (sequence: bigint): NormalizedEvent => ({
  ...chunk(sequence, 0),
  content: undefined,
});

describe("the per-run output budget (CORE-04)", () => {
  it("stores content up to the budget and keeps every event row", () => {
    const state = makeOutputBudgetState();
    const result = applyOutputBudget(state, [chunk(1n, 40), marker(2n), chunk(3n, 60)], 100);
    expect(result.lossSpan).toBeUndefined();
    expect(result.batch.map((event) => event.content?.bytes.byteLength)).toEqual([
      40,
      undefined,
      60,
    ]);
    expect(state.storedBytes).toBe(100);
  });

  it("drops the bytes past the budget, not the events, and says so once", () => {
    const state = makeOutputBudgetState();
    const first = applyOutputBudget(state, [chunk(1n, 80), chunk(2n, 40), chunk(3n, 10)], 100);
    expect(first.batch).toHaveLength(3);
    // The 40-byte chunk does not fit; the 10-byte one after it still does.
    expect(first.batch.map((event) => event.content !== undefined)).toEqual([true, false, true]);
    // A dropped chunk's scrollback row names no artifact: readers treat it as a hole. With the
    // hash left in place they look the artifact up, miss, and fail the read of the whole run.
    expect(first.batch.map((event) => event.scrollback?.contentHash)).toEqual([
      "h1",
      undefined,
      "h3",
    ]);
    expect(first.batch[1]?.scrollback?.byteCount).toBe(40n);
    expect(first.lossSpan).toMatchObject({
      kind: "dropped_event",
      fromSequence: 2n,
      atSequence: 2n,
      detectedVia: "marker",
    });
    expect(first.lossSpan?.reason).toContain("100 bytes");

    const second = applyOutputBudget(state, [chunk(4n, 50)], 100);
    expect(second.batch[0]?.content).toBeUndefined();
    expect(second.lossSpan).toBeUndefined();
    expect(state.storedBytes).toBe(90);
  });

  it("is off at 0", () => {
    const state = makeOutputBudgetState();
    const result = applyOutputBudget(state, [chunk(1n, 5_000_000)], 0);
    expect(result.batch[0]?.content).toBeDefined();
    expect(result.lossSpan).toBeUndefined();
  });
});
