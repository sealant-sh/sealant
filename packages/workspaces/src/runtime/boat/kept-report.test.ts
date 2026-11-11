import { describe, expect, it } from "vitest";

import { boatConvergenceObligations } from "./convergence.js";
import { BOAT_KEPT_REPORT_MS, boatKeptReports } from "./kept-report.js";
import { boatAllocationObligations } from "./vm.js";

describe("Boat kept reports", () => {
  it("are due when a run is first asked about, then once a period, each run on its own", () => {
    const due = boatKeptReports();
    expect(due("run_a", 0)).toBe(true);
    expect(due("run_a", 30_000)).toBe(false);
    // Another run's first report is not held back by this one's.
    expect(due("run_b", 30_000)).toBe(true);
    expect(due("run_a", BOAT_KEPT_REPORT_MS - 1)).toBe(false);
    expect(due("run_a", BOAT_KEPT_REPORT_MS)).toBe(true);
    expect(due("run_a", BOAT_KEPT_REPORT_MS + 30_000)).toBe(false);
    expect(due("run_b", BOAT_KEPT_REPORT_MS + 30_000)).toBe(true);
  });

  it("forget runs last reported more than a period ago once many are remembered", () => {
    const due = boatKeptReports(1_000);
    for (let run = 0; run < 2_000; run += 1) expect(due(`run_${String(run)}`, run)).toBe(true);
    // Still inside its period, and still remembered.
    expect(due("run_1999", 2_000)).toBe(false);
  });
});

const always = () => true;
const never = () => false;

describe("Boat allocation obligations", () => {
  it("never lists a launch still being created, a bound run or a deleted one", () => {
    expect(
      boatAllocationObligations(
        [
          { runId: "run_pending", outcome: "pending" },
          { runId: "run_bound", outcome: "bound" },
          { runId: "run_deleted", outcome: "deleted" },
        ],
        always,
      ),
    ).toEqual([]);
  });

  it("lists a failed read and a conflict on every pass, whatever was reported before", () => {
    const entries = [
      { runId: "run_unavailable", outcome: "unavailable" },
      { runId: "run_conflict", outcome: "held", held: "allocation-conflict" },
    ] as const;
    expect(boatAllocationObligations(entries, never)).toEqual(entries);
  });

  it("lists any other held run only when its report is due", () => {
    const entries = [
      { runId: "run_unresolved", outcome: "held", held: "create-unresolved" },
      { runId: "run_stopped", outcome: "held", held: "run-stopped" },
      { runId: "run_refused", outcome: "held" },
    ] as const;
    expect(boatAllocationObligations(entries, never)).toEqual([]);
    expect(boatAllocationObligations(entries, (runId) => runId === "run_stopped")).toEqual([
      { runId: "run_stopped", outcome: "held", held: "run-stopped" },
    ]);
  });
});

describe("Boat convergence obligations", () => {
  it("lists what nothing is settling on every pass, and a held run only when its report is due", () => {
    const entries = [
      { runId: "run_stopped", outcome: "stopped" },
      { runId: "run_draining", outcome: "draining" },
      { runId: "run_kept", outcome: "kept" },
      { runId: "run_busy", outcome: "busy" },
      { runId: "run_cleaned", outcome: "cleaned" },
      { runId: "run_skipped", outcome: "skipped" },
      { runId: "run_discharging", outcome: "discharging" },
      { runId: "run_unavailable", outcome: "unavailable" },
      { runId: "run_held", outcome: "held" },
    ] as const;
    expect(boatConvergenceObligations(entries, never)).toEqual([
      { runId: "run_discharging", outcome: "discharging" },
      { runId: "run_unavailable", outcome: "unavailable" },
    ]);
    expect(boatConvergenceObligations(entries, always)).toEqual([
      { runId: "run_discharging", outcome: "discharging" },
      { runId: "run_unavailable", outcome: "unavailable" },
      { runId: "run_held", outcome: "held" },
    ]);
  });
});
