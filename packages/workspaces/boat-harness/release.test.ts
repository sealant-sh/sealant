import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeBoatEvent } from "./fake-boat.js";
import { assertReleased, cleanStop, type ReleaseRun, type ReleaseStack } from "./scenario.js";

/** The runtime row `runtimeView` reads: released and cleanly stopped unless overridden. */
const row = (extra: Record<string, unknown> = {}) => ({
  status: "stopped",
  error_code: null,
  error: null,
  stop_reason: "user",
  removed: true,
  allocation: "deleted",
  sandbox: "bx_aaaaaaaa",
  execution: "stopped",
  tunnel_released: true,
  has_tunnel: true,
  pin: "released",
  drain: "stopped",
  retained: false,
  ...extra,
});

let nextRun = 0;

/**
 * One launch and the stack around it. `statuses` is what Mend reads on successive polls (the last
 * repeats); `pinUntilDiscard` keeps the publication pin pending until the owner's discard.
 */
const world = (input: {
  readonly row?: Record<string, unknown>;
  readonly statuses?: readonly string[];
  readonly pinUntilDiscard?: boolean;
}) => {
  const runId = `00000000-0000-0000-0000-${String(++nextRun).padStart(12, "0")}`;
  let discarded = false;
  let polls = 0;
  const events: FakeBoatEvent[] = [{ at: 2000, kind: "delete", sandboxId: "bx_aaaaaaaa" }];
  const stack: ReleaseStack = {
    query: async (sql: string) => {
      if (sql.includes("headN"))
        return [{ complete: "true", head_n: 3, last_status_at: new Date(1990).toISOString() }];
      if (sql.includes("from boat_runs where")) return [];
      const pin = input.pinUntilDiscard === true && !discarded ? "pending" : "released";
      return [row({ pin, ...input.row })];
    },
    ownedObjects: async () => ({ containers: [], networks: [], volumes: [], images: [] }),
    boat: {
      sandboxes: new Map([
        ["bx_aaaaaaaa", { id: "bx_aaaaaaaa", labels: { "sealant-run": runId } }],
      ]),
      events,
      liveSandboxes: () => [],
    },
  };
  const statuses = input.statuses ?? ["stopped"];
  const run: ReleaseRun = {
    runId,
    startedAt: 1000,
    workspace: {
      // Mend reads the scripted statuses until the owner's discard, then `stopped`.
      status: async () => {
        if (discarded) return "stopped";
        const status = statuses[Math.min(polls++, statuses.length - 1)] ?? "stopped";
        return status === "retained" ? "retained" : "stopped";
      },
      stop: async (options) => {
        if (options?.discardUnsaved === true) discarded = true;
      },
    },
    capture: {
      state: async () => ({
        registers: [{ at: 1500, n: 3, final: false, sealRecorded: false }],
      }),
    },
  };
  return { stack, run, wasDiscarded: () => discarded };
};

/** Runs `assertReleased` to completion, driving its waits on fake timers. */
const settle = async <T>(work: Promise<T>): Promise<T> => {
  // Observed at once, so a rejection while the timers advance is never unhandled.
  const state = { done: false };
  const finish = () => {
    state.done = true;
    return undefined;
  };
  void work.then(finish, finish);
  for (let step = 0; step < 200; step++) {
    if (state.done) break;
    await vi.advanceTimersByTimeAsync(3000);
  }
  return work;
};

describe("assertReleased", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a clean Stop whose FINAL was checked", async () => {
    const { stack, run } = world({});
    await cleanStop(run);
    await expect(settle(assertReleased(stack, run, { discard: false }))).resolves.toBeUndefined();
  });

  it("fails a clean Stop whose FINAL check was skipped, whoever wrote the stop columns", async () => {
    for (const extra of [{ stop_reason: null }, { stop_reason: "expired" }]) {
      const { stack, run } = world({ row: extra });
      await cleanStop(run);
      await expect(settle(assertReleased(stack, run, { discard: false }))).rejects.toThrow(
        /invariant not checked .*FINAL check was skipped: stop_reason/,
      );
    }
  });

  it("does not require a FINAL of a launch its scenario did not stop", async () => {
    const { stack, run } = world({ row: { stop_reason: null } });
    await expect(settle(assertReleased(stack, run, { discard: false }))).resolves.toBeUndefined();
  });

  it("fails a passing scenario whose launch released only after the owner's discard", async () => {
    const { stack, run, wasDiscarded } = world({
      statuses: ["retained"],
      pinUntilDiscard: true,
      row: { stop_reason: null },
    });
    await expect(settle(assertReleased(stack, run))).rejects.toThrow(
      /released only after the owner's discard; 60 s after the scenario it was retained with publication pin pending/,
    );
    expect(wasDiscarded()).toBe(true);
  });

  it("accepts the discard as cleanup after the scenario's body already failed", async () => {
    const { stack, run } = world({
      statuses: ["retained"],
      pinUntilDiscard: true,
      row: { stop_reason: null },
    });
    await expect(settle(assertReleased(stack, run, { bodyFailed: true }))).resolves.toBeUndefined();
  });
});
