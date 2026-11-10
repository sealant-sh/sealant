import { describe, expect, it } from "vitest";

import type { FakeBoatEvent } from "./fake-boat.js";
import { assertInvariants } from "./scenario.js";
import type { CaptureRegister } from "./stack.js";

const RUN = "11111111-2222-3333-4444-555555555555";

/** The runtime row `runtimeView` reads, for a cleanly stopped run unless overridden. */
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

const world = (input: {
  readonly vms?: readonly string[];
  readonly events?: readonly FakeBoatEvent[];
  readonly registers?: readonly CaptureRegister[];
  readonly row?: Record<string, unknown>;
  /** Core's FINAL drain status: complete, at head 3, unless overridden. */
  readonly drain?: Record<string, unknown>;
}) => {
  const vms = input.vms ?? ["bx_aaaaaaaa"];
  return {
    stack: {
      query: async (sql: string) =>
        sql.includes("headN")
          ? [{ complete: "true", head_n: 3, ...input.drain }]
          : [row(input.row)],
      boat: {
        sandboxes: new Map(vms.map((id) => [id, { id, labels: { "sealant-run": RUN } }])),
        events: input.events ?? [{ at: 2000, kind: "delete", sandboxId: "bx_aaaaaaaa" }],
      },
    },
    run: {
      runId: RUN,
      startedAt: 1000,
      capture: { state: async () => ({ registers: input.registers ?? [] }) },
    },
  };
};

/** The channel's answer to register `n` at `at` (the harness channel sends no FINAL seal). */
const register = (at: number, n = 3): CaptureRegister => ({
  at,
  n,
  final: false,
  sealRecorded: false,
});

describe("invariants checked after every scenario", () => {
  it("hold for a clean Stop whose FINAL head was registered before the delete", async () => {
    const { stack, run } = world({ registers: [register(1400, 2), register(1500)] });
    await expect(assertInvariants(stack, run, { discarded: false })).resolves.toBeUndefined();
  });

  it("fail when the delete came before the FINAL head, or Core's FINAL never completed", async () => {
    for (const input of [
      { registers: [register(2500)] },
      { registers: [] },
      { registers: [register(1500, 2)] },
      { registers: [register(1500)], drain: { complete: "false" } },
      { registers: [register(1500)], drain: { complete: null, head_n: null } },
    ]) {
      const { stack, run } = world(input);
      await expect(assertInvariants(stack, run, { discarded: false })).rejects.toThrow(
        /no FINAL was captured before Boat was asked to delete bx_aaaaaaaa/,
      );
    }
  });

  it("ignore an earlier run's FINAL on the same capture session", async () => {
    const { stack, run } = world({ registers: [register(500)] });
    await expect(assertInvariants(stack, run, { discarded: false })).rejects.toThrow(/no FINAL/);
  });

  it("do not require a FINAL of a failed launch or an owner's discard", async () => {
    const failed = world({ row: { error_code: "launch-retained", stop_reason: null } });
    await expect(
      assertInvariants(failed.stack, failed.run, { discarded: false }),
    ).resolves.toBeUndefined();
    const discarded = world({});
    await expect(
      assertInvariants(discarded.stack, discarded.run, { discarded: true }),
    ).resolves.toBeUndefined();
  });

  it("fail when one run ever had two VMs, whatever else happened", async () => {
    const { stack, run } = world({
      vms: ["bx_aaaaaaaa", "bx_bbbbbbbb"],
      registers: [register(1500)],
    });
    await expect(assertInvariants(stack, run, { discarded: true })).rejects.toThrow(
      /had 2 VMs \(bx_aaaaaaaa, bx_bbbbbbbb\); a run has at most one/,
    );
  });
});
