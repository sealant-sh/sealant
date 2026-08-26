import type { Run, RunExecClaim } from "@sealant/db";
import { describe, expect, it } from "vitest";

import { runExecClaimAction } from "./process-run-exec-job.js";

const run = (status: Run["status"]): Run => ({
  id: "run-1",
  workspaceId: "ws-1",
  attemptId: null,
  ownerUserId: "user-1",
  harnessId: "codex",
  mode: "one-shot",
  status,
  prompt: null,
  command: null,
  metadata: null,
  exitCode: null,
  errorMessage: null,
  diff: null,
  changedFiles: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("runExecClaimAction", () => {
  it("executes only a freshly claimed run", () => {
    const claim: RunExecClaim = { outcome: "claimed", run: run("running") };
    expect(runExecClaimAction(claim)).toBe("execute");
  });

  it("skips a redelivery that finds the run already terminal", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const claim: RunExecClaim = { outcome: "terminal", run: run(status) };
      expect(runExecClaimAction(claim)).toBe("skip-terminal");
    }
  });

  it("fails (never re-executes) a redelivery that finds the run mid-flight", () => {
    const claim: RunExecClaim = { outcome: "already-running", run: run("running") };
    expect(runExecClaimAction(claim)).toBe("fail-already-running");
  });

  it("fails a job for a run that does not exist", () => {
    expect(runExecClaimAction({ outcome: "not-found" })).toBe("fail-missing");
  });
});
