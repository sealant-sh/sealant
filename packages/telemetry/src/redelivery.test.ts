/**
 * What `appendBatch` reports about the events its insert did not take: the same event again is
 * nothing (whichever run it was stored under, whenever), a different one at the same id or the
 * same position is a conflict.
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { TelemetryEvent } from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { describe, expect, it } from "vitest";

import { eventRow, normalizeEnvelope } from "./normalize.js";
import { conflictingRedeliveries } from "./redelivery.js";

const event = (sequence: bigint, init: MessageInitShape<typeof EventEnvelopeSchema> = {}) =>
  normalizeEnvelope(
    create(EventEnvelopeSchema, {
      schemaVersion: 1,
      eventId: `evt_${sequence.toString()}`,
      runtimeId: "rt_1",
      processId: "proc_1",
      sequence,
      observedAt: sequence * 1000n,
      monotonicTimestamp: sequence * 10n,
      payload: {
        case: "ioChunk",
        value: {
          stream: StreamKind.STDOUT,
          byteCount: 3n,
          streamOffset: 0n,
          content: new TextEncoder().encode("hi\n"),
        },
      },
      ...init,
    }),
  );

/** The row as Postgres hands it back: jsonb reorders the payload's keys. */
const storedRow = (sequence: bigint, runId: string, init = {}): TelemetryEvent => {
  const row = eventRow(event(sequence, init), runId);
  const reordered = Object.fromEntries(Object.entries(row.payload).toReversed());
  return {
    ...row,
    executionId: row.executionId ?? null,
    sessionId: row.sessionId ?? null,
    processId: row.processId ?? null,
    requestId: row.requestId ?? null,
    payload: reordered,
    ingestedAt: new Date(0),
  };
};

describe("conflictingRedeliveries", () => {
  it("finds nothing for the same event stored under another run at another time", () => {
    expect(conflictingRedeliveries([event(1n)], [storedRow(1n, "run_launch")])).toEqual([]);
  });

  it("finds nothing for a process start whose arguments were withheld", () => {
    const started = {
      payload: {
        case: "processStarted" as const,
        value: { pid: 7, executable: "sh", args: ["-c", "echo secret"], cwd: "/" },
      },
    };
    expect(
      conflictingRedeliveries([event(2n, started)], [storedRow(2n, "run_1", started)]),
    ).toEqual([]);
  });

  it("names what differs for the same id with other content", () => {
    const stored = storedRow(3n, "run_1");
    const redelivered = { ...event(4n), eventId: "evt_3" };
    expect(conflictingRedeliveries([redelivered], [stored])).toEqual([
      {
        eventId: "evt_3",
        runtimeId: "rt_1",
        sequence: "4",
        storedEventIdAtSequence: undefined,
        differences: ["sequence", "observedAt", "monotonicTimestamp"],
      },
    ]);
  });

  it("names the stored event that holds the same position under another id", () => {
    const redelivered = { ...event(5n), eventId: "evt_other" };
    expect(conflictingRedeliveries([redelivered], [storedRow(5n, "run_1")])).toEqual([
      {
        eventId: "evt_other",
        runtimeId: "rt_1",
        sequence: "5",
        storedEventIdAtSequence: "evt_5",
        differences: ["eventId"],
      },
    ]);
  });
});
