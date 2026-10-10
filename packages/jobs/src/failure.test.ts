/**
 * A delivery's failure must be recordable: pg-boss stores it with `JSON.stringify`, which throws on
 * a bigint. The run-exec worker failed with a telemetry query error whose parameters were bigint
 * sequences, and pg-boss logged "Do not know how to serialize a BigInt" instead of the failure.
 */
import { describe, expect, it } from "vitest";

import { JobFailure, toJobFailure } from "./failure.js";

class QueryError extends Error {
  readonly params: readonly unknown[];
  constructor(params: readonly unknown[]) {
    super("Failed query: insert into telemetry_events");
    this.name = "QueryError";
    this.params = params;
  }
}

class SinkError extends Error {
  readonly _tag = "TelemetrySinkUnexpectedError";
  readonly operation = "appendBatch";
  constructor(cause: unknown) {
    super("insert failed", { cause });
    this.name = "TelemetrySinkUnexpectedError";
  }
}

describe("toJobFailure", () => {
  it("turns an error whose cause carries bigints into one JSON.stringify accepts", () => {
    const original = new SinkError(new QueryError(["evt_1", 257n, new Uint8Array(4)]));
    expect(() => JSON.stringify(original.cause)).toThrow(/BigInt/);

    const failure = toJobFailure(original);
    expect(failure).toBeInstanceOf(JobFailure);
    expect(failure.name).toBe("TelemetrySinkUnexpectedError");
    expect(failure.message).toBe("insert failed");
    expect(failure.stack).toBe(original.stack);
    expect(JSON.parse(JSON.stringify({ ...failure }))).toEqual({
      name: "TelemetrySinkUnexpectedError",
      detail: {
        name: "TelemetrySinkUnexpectedError",
        message: "insert failed",
        _tag: "TelemetrySinkUnexpectedError",
        operation: "appendBatch",
        cause: {
          name: "QueryError",
          message: "Failed query: insert into telemetry_events",
          params: ["evt_1", "257", "[4 bytes]"],
        },
      },
    });
  });

  it("survives a cycle and a non-Error throw", () => {
    const cyclic: Record<string, unknown> = { at: 1n };
    cyclic["self"] = cyclic;
    expect(JSON.stringify(toJobFailure(cyclic).detail)).toBe('{"at":"1","self":"[Circular]"}');
    expect(toJobFailure("boom").message).toBe("boom");
    expect(toJobFailure({ sequence: 9n }).message).toBe('{"sequence":"9"}');
  });
});
