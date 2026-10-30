/**
 * The harness framing through the run-exec job: its exec is sent once, and when the answer is
 * lost the run fails saying whether the harness started is unknown, never sent again. Driven
 * against the telemetry package's scripted workspace.
 */
import { RunRepo } from "@sealant/db";
import { FAKE_WORKSPACE_ID, fakeExecWorld, fakeWorkspaceRepos } from "@sealant/telemetry/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { processRunExecJobEffect } from "./process-run-exec-job.js";

const RUN = "run_harness";
const OWNER = "usr_1";

describe("a harness run whose exec answer is lost", () => {
  it("sends the harness once and fails the run with the harness reason", async () => {
    const w = fakeExecWorld();
    const layer = Layer.mergeAll(w.layer, fakeWorkspaceRepos(OWNER));
    await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* RunRepo;
        yield* runs.createRun({
          id: RUN,
          workspaceId: FAKE_WORKSPACE_ID,
          ownerUserId: OWNER,
          harnessId: "opencode",
        });
        yield* processRunExecJobEffect({
          runId: RUN,
          command: { executable: "opencode", args: ["lost"] },
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(w.sent.filter((exec) => exec.executionId === RUN)).toHaveLength(1);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${RUN}: the harness was sent to the workspace and its answer was lost, so whether it started is unknown; it may still be running. It was not sent again.`,
    });
  });
});
