import {
  RunRepo,
  WorkspaceRepo,
  type RunRepoService,
  type WorkspaceRepoService,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { RunExecPublisherService } from "../../services/control-plane-capabilities.js";
import { CurrentPrincipal, type RequestPrincipal } from "../../services/service-principals.js";
import { createRun, getRun, listRuns, updateRun } from "./runs.module.js";

/**
 * CORE-03: every run operation is made for a named owner. These pin the refusals and that a
 * refused call reaches no write: the stubs count every mutation.
 */

const now = new Date("2026-09-17T00:00:00.000Z");
const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: "run_1",
  workspaceId: "ws_a",
  ownerUserId: "usr_a",
  harnessId: "claude-code",
  mode: "one-shot",
  status: "queued",
  prompt: null,
  command: null,
  metadata: null,
  attemptId: null,
  exitCode: null,
  errorMessage: null,
  diff: null,
  changedFiles: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const world = (run = runRow()) => {
  const writes: Array<string> = [];
  const lookups: Array<string> = [];
  const wrote = (name: string) =>
    Effect.sync(() => {
      writes.push(name);
      return run;
    });
  const runs = {
    getRunById: (id: string) =>
      Effect.sync(() => {
        lookups.push(id);
        return id === run.id ? run : undefined;
      }),
    listRuns: () => Effect.succeed([run]),
    createRun: () => wrote("createRun"),
    markRunRunning: () => wrote("markRunRunning"),
    markRunCompleted: () => wrote("markRunCompleted"),
    markRunFailed: () => wrote("markRunFailed"),
    setRunCapturedChanges: () => wrote("setRunCapturedChanges"),
  } as unknown as RunRepoService;
  const workspaces = {
    getWorkspaceById: (id: string) =>
      Effect.succeed(id === "ws_a" ? { id: "ws_a", ownerUserId: "usr_a" } : undefined),
  } as unknown as WorkspaceRepoService;
  const layers = Layer.mergeAll(
    Layer.succeed(RunRepo, runs),
    Layer.succeed(WorkspaceRepo, workspaces),
    Layer.succeed(RunExecPublisherService, {
      publishRequested: async () => {
        writes.push("publishRequested");
      },
    } as unknown as RunExecPublisherService["Service"]),
  );
  const execute = <A, E>(
    effect: Effect.Effect<A, E, RunRepo | WorkspaceRepo | RunExecPublisherService>,
    principal: RequestPrincipal = { kind: "service" },
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(CurrentPrincipal, principal),
        Effect.provide(layers),
        Effect.result,
      ),
    );
  return { writes, lookups, run: execute };
};

describe("runs are read and changed for a named owner", () => {
  it("finds nothing for a read that names no owner, without a lookup", async () => {
    const { run, lookups } = world();
    const result = await run(getRun("run_1", undefined));
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/ownerUserId is required/);
    expect(lookups).toEqual([]);
  });

  it("answers another owner's run exactly like a missing one", async () => {
    const { run } = world();
    const foreign = await run(getRun("run_1", "usr_b"));
    const missing = await run(getRun("run_nope", "usr_b"));
    expect(Result.isFailure(foreign) && Result.isFailure(missing)).toBe(true);
    expect(String(foreign).replace("run_1", "X")).toBe(String(missing).replace("run_nope", "X"));
    expect(Result.isSuccess(await run(getRun("run_1", "usr_a")))).toBe(true);
  });

  it("refuses a listing across owners", async () => {
    const { run } = world();
    expect(Result.isFailure(await run(listRuns({})))).toBe(true);
    expect(Result.isSuccess(await run(listRuns({ ownerUserId: "usr_a" })))).toBe(true);
  });

  it("an update that names no owner, or another owner, changes nothing", async () => {
    const { run, writes } = world();
    for (const ownerUserId of [undefined, "usr_b"]) {
      const result = await run(
        updateRun({
          runId: "run_1",
          payload: { ...(ownerUserId === undefined ? {} : { ownerUserId }), status: "completed" },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
    expect(writes).toEqual([]);
  });

  it("a run is created only in the named owner's workspace", async () => {
    const { run, writes } = world();
    const result = await run(
      createRun({ workspaceId: "ws_a", ownerUserId: "usr_b", harnessId: "claude-code" }),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/Workspace not found/);
    expect(writes).toEqual([]);
  });
});

describe("the SSH gateway's secret is a narrower authority than a service key", () => {
  const gateway: RequestPrincipal = { kind: "gateway" };

  it("creates interactive ssh runs only", async () => {
    const { run, writes } = world();
    const refused = await run(
      createRun({
        workspaceId: "ws_a",
        ownerUserId: "usr_a",
        harnessId: "claude-code",
        prompt: "rm -rf",
      }),
      gateway,
    );
    expect(Result.isFailure(refused)).toBe(true);
    expect(writes).toEqual([]);

    const recorded = await run(
      createRun({
        workspaceId: "ws_a",
        ownerUserId: "usr_a",
        harnessId: "ssh",
        mode: "interactive",
      }),
      gateway,
    );
    expect(Result.isSuccess(recorded)).toBe(true);
    expect(writes).toEqual(["createRun"]);
  });

  it("updates the runs it records and no other harness's", async () => {
    const harnessRun = world();
    const refused = await harnessRun.run(
      updateRun({ runId: "run_1", payload: { ownerUserId: "usr_a", status: "completed" } }),
      gateway,
    );
    expect(Result.isFailure(refused)).toBe(true);
    expect(harnessRun.writes).toEqual([]);

    const sshRun = world(runRow({ harnessId: "ssh", mode: "interactive", status: "running" }));
    const recorded = await sshRun.run(
      updateRun({ runId: "run_1", payload: { ownerUserId: "usr_a", status: "completed" } }),
      gateway,
    );
    expect(Result.isSuccess(recorded)).toBe(true);
    expect(sshRun.writes.length).toBeGreaterThan(0);
  });
});
