/**
 * Pure unit tests for the normalization + projection-derivation core. No Effect runtime, no DB.
 * These prove the invariants the whole package leans on: lossless bigint handling, jsonb-safety,
 * ingest-derivation == rebuild-derivation, gap detection, and byte-exact scrollback reassembly.
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { TelemetryEvent } from "@sealant/db";
import { EventPriority, StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { describe, expect, it } from "vitest";

import {
  deriveScrollbackRow,
  deriveTimelineRow,
  detectGap,
  eventRow,
  eventRowToNormalized,
  normalizeEnvelope,
  reassembleByStreamOffset,
} from "./normalize.js";
import type { GapDetectionState } from "./types.js";

type EnvelopeInit = MessageInitShape<typeof EventEnvelopeSchema>;

let nextId = 0;
const makeEnvelope = (init: EnvelopeInit) =>
  create(EventEnvelopeSchema, {
    schemaVersion: 1,
    eventId: init.eventId ?? `evt_${nextId++}`,
    runtimeId: "rt_test",
    sequence: 1n,
    observedAt: 1000n,
    monotonicTimestamp: 2000n,
    captureMethod: 1,
    confidence: 1,
    ...init,
  });

/** Round-trip a NormalizedEvent through the stored-row shape (the rebuild path) for parity checks. */
const asStoredRow = (
  event: ReturnType<typeof normalizeEnvelope>,
  runId: string,
): TelemetryEvent => ({
  ...eventRow(event, runId),
  executionId: event.executionId ?? null,
  sessionId: event.sessionId ?? null,
  processId: event.processId ?? null,
  requestId: event.requestId ?? null,
  ingestedAt: new Date(0),
});

describe("normalizeEnvelope", () => {
  it("splits ioChunk content out for offload and keeps a jsonb-safe payload", () => {
    const bytes = new TextEncoder().encode("hello");
    const env = makeEnvelope({
      processId: "proc_1",
      sequence: 7n,
      payload: {
        case: "ioChunk",
        value: { stream: StreamKind.STDOUT, byteCount: 5n, streamOffset: 0n, content: bytes },
      },
    });

    const n = normalizeEnvelope(env);

    expect(n.payloadCase).toBe("ioChunk");
    expect(n.content?.algo).toBe("sha256");
    expect(n.content?.bytes).toEqual(bytes);
    expect(n.scrollback?.streamOffset).toBe(0n);
    expect(n.scrollback?.byteCount).toBe(5n);
    expect(n.scrollback?.contentHash).toBe(n.content?.hash);
    // bigints are stringified in the payload, raw bytes are NOT present
    expect(n.payload.byteCount).toBe("5");
    expect(n.payload.streamOffset).toBe("0");
    expect("content" in n.payload).toBe(false);
    // jsonb-safe: stringify must not throw on a bigint
    expect(() => JSON.stringify(n.payload)).not.toThrow();
  });

  it("preserves ioChunk metadata when content is absent (metadata-only)", () => {
    const env = makeEnvelope({
      processId: "proc_1",
      payload: {
        case: "ioChunk",
        value: { stream: StreamKind.STDERR, byteCount: 12n, streamOffset: 40n },
      },
    });
    const n = normalizeEnvelope(env);
    expect(n.content).toBeUndefined();
    expect(n.scrollback?.byteCount).toBe(12n);
    expect(n.scrollback?.streamOffset).toBe(40n);
    expect(n.scrollback?.contentHash).toBeUndefined();
  });

  it("maps an absent payload oneof to the 'unknown' case", () => {
    const n = normalizeEnvelope(makeEnvelope({}));
    expect(n.payloadCase).toBe("unknown");
    expect(() => JSON.stringify(n.payload)).not.toThrow();
  });

  it("preserves a near-2^63 uint64 sequence as bigint without narrowing", () => {
    const big = 9000000000000000001n;
    const n = normalizeEnvelope(
      makeEnvelope({
        sequence: big,
        payload: { case: "runtimeHeartbeat", value: { state: 2 } },
      }),
    );
    expect(n.sequence).toBe(big);
    expect(Number.isSafeInteger(Number(n.sequence))).toBe(false);
  });
});

describe("projection derivation is identical at ingest and rebuild", () => {
  it("ingest-derived rows equal rebuild-derived rows (ioChunk)", () => {
    const env = makeEnvelope({
      processId: "proc_9",
      sequence: 3n,
      payload: {
        case: "ioChunk",
        value: {
          stream: StreamKind.STDOUT,
          byteCount: 3n,
          streamOffset: 10n,
          content: new TextEncoder().encode("abc"),
        },
      },
    });
    const ingest = normalizeEnvelope(env);
    const rebuilt = eventRowToNormalized(asStoredRow(ingest, "run_1"));

    expect(deriveTimelineRow(rebuilt, "run_1")).toEqual(deriveTimelineRow(ingest, "run_1"));
    expect(deriveScrollbackRow(rebuilt, "run_1")).toEqual(deriveScrollbackRow(ingest, "run_1"));
  });

  it("ingest-derived rows equal rebuild-derived rows (processExited)", () => {
    const env = makeEnvelope({
      processId: "proc_9",
      sequence: 4n,
      payload: {
        case: "processExited",
        value: { exitCode: 0, reason: 1, durationMicros: 123456n },
      },
    });
    const ingest = normalizeEnvelope(env);
    const rebuilt = eventRowToNormalized(asStoredRow(ingest, "run_1"));
    expect(deriveTimelineRow(rebuilt, "run_1")).toEqual(deriveTimelineRow(ingest, "run_1"));
    expect(rebuilt.summary).toBe(ingest.summary);
  });
});

const freshState = (): GapDetectionState => ({ lastSequenceByRuntime: new Map() });

describe("detectGap", () => {
  it("reports no loss for sequential events", () => {
    const state = freshState();
    expect(detectGap(state, makeEnvelope({ sequence: 1n })).lossSpan).toBeUndefined();
    expect(detectGap(state, makeEnvelope({ sequence: 2n })).lossSpan).toBeUndefined();
  });

  it("infers a sequence_gap when sequence jumps", () => {
    const state = freshState();
    detectGap(state, makeEnvelope({ sequence: 5n }));
    const { lossSpan } = detectGap(state, makeEnvelope({ sequence: 8n }));
    expect(lossSpan?.kind).toBe("sequence_gap");
    expect(lossSpan?.fromSequence).toBe(6n);
    expect(lossSpan?.toSequence).toBe(7n);
    expect(lossSpan?.droppedCount).toBe(2n);
    expect(lossSpan?.detectedVia).toBe("gap");
  });

  it("records an explicit telemetryDropped marker", () => {
    const { lossSpan } = detectGap(
      freshState(),
      makeEnvelope({
        sequence: 1n,
        payload: {
          case: "telemetryDropped",
          value: { reason: "queue_full", count: 9n, priority: EventPriority.LOW },
        },
      }),
    );
    expect(lossSpan?.kind).toBe("dropped_event");
    expect(lossSpan?.droppedCount).toBe(9n);
    expect(lossSpan?.detectedVia).toBe("marker");
  });

  it("treats a new runtimeId as a fresh epoch, never a gap", () => {
    const state = freshState();
    detectGap(state, makeEnvelope({ runtimeId: "rt_a", sequence: 100n }));
    const { lossSpan } = detectGap(state, makeEnvelope({ runtimeId: "rt_b", sequence: 1n }));
    expect(lossSpan).toBeUndefined();
  });
});

describe("reassembleByStreamOffset", () => {
  it("concatenates ordered byte runs by offset", () => {
    const result = reassembleByStreamOffset([
      { streamOffset: 5n, bytes: new TextEncoder().encode("World") },
      { streamOffset: 0n, bytes: new TextEncoder().encode("Hello") },
    ]);
    expect(new TextDecoder().decode(result.bytes)).toBe("HelloWorld");
    expect(result.gaps).toHaveLength(0);
  });

  it("surfaces an explicit gap when a middle run is missing", () => {
    const result = reassembleByStreamOffset([
      { streamOffset: 0n, bytes: new TextEncoder().encode("aa") },
      { streamOffset: 10n, bytes: new TextEncoder().encode("bb") },
    ]);
    expect(result.gaps).toEqual([{ from: 2n, to: 10n }]);
    expect(new TextDecoder().decode(result.bytes)).toBe("aabb");
  });
});
