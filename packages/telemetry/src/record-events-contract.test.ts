/**
 * Guards the contract's record-event taxonomy against THIS package (the platform source of truth):
 *
 *  1. the kind lists must be identical (the contract deliberately does not depend on telemetry, so
 *     drift is caught here instead of by the type system);
 *  2. a REAL envelope, run through the REAL ingest normalization (`normalizeEnvelope` — bigints
 *     stringified, `$typeName` included, ioChunk content offloaded), must decode into the typed
 *     case via the contract schemas — not degrade to `unknown`.
 */
import { create } from "@bufbuild/protobuf";
import { decodeRecordEventPayload, recordEventKindValues } from "@sealant/api-contracts";
import {
  EventEnvelopeSchema,
  FileChangeSchema,
  FileDiffAvailableSchema,
  FileSnapshotCompletedSchema,
  FileWatchOverflowSchema,
  IoChunkSchema,
  NetworkRequestSchema,
  NetworkSourceObservedSchema,
  ProcessExitedSchema,
  ProcessStartedSchema,
  RuntimeHeartbeatSchema,
  RuntimeStateChangedSchema,
  TelemetryDroppedSchema,
  type EventEnvelope,
} from "@sealant/runtime-protocol";
import { describe, expect, it } from "vitest";

import { normalizeEnvelope } from "./normalize.js";
import { payloadCaseValues } from "./types.js";

const envelope = (payload: EventEnvelope["payload"]): EventEnvelope =>
  create(EventEnvelopeSchema, {
    schemaVersion: 0,
    eventId: "evt_1",
    runtimeId: "rt_1",
    sequence: 1n,
    observedAt: 1n,
    monotonicTimestamp: 1n,
    captureMethod: 1,
    confidence: 1,
    payload,
  });

describe("record-event taxonomy contract", () => {
  it("the contract's kind list mirrors payloadCaseValues exactly", () => {
    expect([...recordEventKindValues]).toEqual([...payloadCaseValues]);
  });

  it("a normalized processStarted envelope decodes into the typed case", () => {
    const normalized = normalizeEnvelope(
      envelope({
        case: "processStarted",
        value: create(ProcessStartedSchema, {
          pid: 42,
          executable: "pnpm",
          args: ["test"],
          cwd: "/workspace/repo",
          startedAt: 1_751_846_400_000_000n,
        }),
      }),
    );

    const decoded = decodeRecordEventPayload(normalized.payloadCase, normalized.payload);
    expect(decoded.kind).toBe("processStarted");
    if (decoded.kind !== "processStarted") {
      return;
    }
    expect(decoded.data.executable).toBe("pnpm");
    expect(decoded.data.args).toEqual(["test"]);
    // int64 survives as a decimal string, and the protobuf $typeName marker is stripped.
    expect(decoded.data.startedAt).toBe("1751846400000000");
    expect(decoded.data).not.toHaveProperty("$typeName");
  });

  it("a normalized networkSourceObserved envelope decodes into the typed case", () => {
    const normalized = normalizeEnvelope(
      envelope({
        case: "networkSourceObserved",
        value: create(NetworkSourceObservedSchema, {
          host: "registry.npmjs.org",
          resolvedIps: ["104.16.0.1"],
          port: 443,
          scheme: 2,
          method: "GET",
          path: "/react",
          status: 200,
        }),
      }),
    );

    const decoded = decodeRecordEventPayload(normalized.payloadCase, normalized.payload);
    expect(decoded.kind).toBe("networkSourceObserved");
    if (decoded.kind !== "networkSourceObserved") {
      return;
    }
    expect(decoded.data.host).toBe("registry.npmjs.org");
    expect(decoded.data.status).toBe(200);
  });

  it("a normalized ioChunk envelope (hand-built payload, content offloaded) decodes typed", () => {
    const normalized = normalizeEnvelope(
      envelope({
        case: "ioChunk",
        value: create(IoChunkSchema, {
          stream: 2,
          byteCount: 6n,
          streamOffset: 0n,
          content: new TextEncoder().encode("hello\n"),
        }),
      }),
    );

    const decoded = decodeRecordEventPayload(normalized.payloadCase, normalized.payload);
    expect(decoded.kind).toBe("ioChunk");
    if (decoded.kind !== "ioChunk") {
      return;
    }
    expect(decoded.data.stream).toBe(2);
    expect(decoded.data.byteCount).toBe("6");
    expect(decoded.data.contentAlgo).toBe("sha256");
  });

  it("every modeled kind round-trips through a normalized envelope without degrading to unknown", () => {
    const messages: ReadonlyArray<EventEnvelope["payload"]> = [
      { case: "runtimeStateChanged", value: create(RuntimeStateChangedSchema, { state: 2 }) },
      { case: "runtimeHeartbeat", value: create(RuntimeHeartbeatSchema, { state: 2 }) },
      {
        case: "processExited",
        value: create(ProcessExitedSchema, { exitCode: 0, reason: 1, durationMicros: 10n }),
      },
      {
        case: "telemetryDropped",
        value: create(TelemetryDroppedSchema, { reason: "backpressure", count: 3n, priority: 1 }),
      },
      {
        case: "fileChange",
        value: create(FileChangeSchema, { kind: 1, path: "src/a.ts", certain: true }),
      },
      {
        case: "fileWatchOverflow",
        value: create(FileWatchOverflowSchema, { root: "/workspace/repo" }),
      },
      {
        case: "fileSnapshotCompleted",
        value: create(FileSnapshotCompletedSchema, { root: "/workspace/repo", fileCount: 12n }),
      },
      {
        case: "fileDiffAvailable",
        value: create(FileDiffAvailableSchema, {
          added: 1n,
          modified: 2n,
          deleted: 0n,
          renamed: 0n,
        }),
      },
      {
        case: "networkRequest",
        value: create(NetworkRequestSchema, {
          scheme: 2,
          host: "api.github.com",
          port: 443,
          bytesSent: 100n,
          bytesReceived: 2000n,
          durationMicros: 5000n,
        }),
      },
    ];
    for (const payload of messages) {
      const normalized = normalizeEnvelope(envelope(payload));
      const decoded = decodeRecordEventPayload(normalized.payloadCase, normalized.payload);
      expect(decoded.kind).toBe(payload.case);
    }
  });

  it("an unmodeled kind and a malformed payload both degrade to the unknown case", () => {
    const novel = decodeRecordEventPayload("fileRead", { path: "/etc/hosts" });
    expect(novel).toEqual({ kind: "unknown", rawKind: "fileRead", data: { path: "/etc/hosts" } });

    const malformed = decodeRecordEventPayload("networkRequest", { host: 42 });
    expect(malformed.kind).toBe("unknown");
    if (malformed.kind === "unknown") {
      expect(malformed.rawKind).toBe("networkRequest");
    }
  });
});
