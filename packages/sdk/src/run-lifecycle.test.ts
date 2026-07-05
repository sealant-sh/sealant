/**
 * Unit tests for the run/start execution paths and `wait()` settling, driven against a stub
 * contract client (no live API): `start()` must return the live handle without polling, and
 * `wait()` must fetch the server-side captured changes once the run is terminal.
 */
import type { Run as WireRun, RunChangesResponse } from "@sealant/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import { runHarness, startHarness } from "./effect/run-harness.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import type { SandboxInit } from "./facade/sandbox.js";
import { opencode } from "./harness.js";
import { resolveInternalConfig } from "./internal/config.js";

const wireRun = (status: WireRun["status"], overrides: Partial<WireRun> = {}): WireRun => ({
  runId: "run_1",
  sandboxId: "sbx_1",
  ownerUserId: "usr_local",
  harnessId: "opencode",
  mode: "one-shot",
  status,
  createdAt: "2026-07-06T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
  ...overrides,
});

const CHANGES: RunChangesResponse = {
  files: [{ path: "src/index.ts", change: "modified" }],
  diff: "diff --git a/src/index.ts b/src/index.ts\n",
};

interface StubCalls {
  createRun: number;
  getRun: number;
  getRunChanges: number;
}

interface StubHandlers {
  readonly createRun?: () => WireRun;
  readonly getRun?: () => WireRun;
  readonly getRunChanges?: () => RunChangesResponse;
}

/**
 * A stub for the contract-derived client covering only the endpoints these paths touch. The derived
 * `ControlPlaneClient` surface is far wider, so the narrowing cast is unavoidable here (test-only).
 */
const makeStub = (handlers: StubHandlers): { client: ControlPlaneClient; calls: StubCalls } => {
  const calls: StubCalls = { createRun: 0, getRun: 0, getRunChanges: 0 };
  const runs = {
    createRun: () => {
      calls.createRun += 1;
      return Effect.sync(() => (handlers.createRun ?? (() => wireRun("queued")))());
    },
    getRun: () => {
      calls.getRun += 1;
      return Effect.sync(() => (handlers.getRun ?? (() => wireRun("completed")))());
    },
    getRunChanges: () => {
      calls.getRunChanges += 1;
      return Effect.sync(() => (handlers.getRunChanges ?? (() => CHANGES))());
    },
  };
  const client = { runs } as unknown as ControlPlaneClient;
  return { client, calls };
};

const makeFakeRuntime = (client: ControlPlaneClient): SdkRuntime => ({
  run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    // The stub provides all of SdkServices; TS can't reduce Exclude<R, SdkServices> for a generic R
    // (the live runtime narrows the same way in effect/runtime.ts).
    Effect.runPromise(
      Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
    ),
  dispose: () => Promise.resolve(),
});

const makeCtx = (client: ControlPlaneClient): SdkContext => ({
  runtime: makeFakeRuntime(client),
  config: resolveInternalConfig({ baseUrl: "http://stub.invalid" }),
});

const SANDBOX: SandboxInit = { id: "sbx_1", name: "t", status: "ready", harness: opencode() };

describe("harness.start()", () => {
  it("returns the live handle immediately without polling or fetching changes", async () => {
    const { client, calls } = makeStub({});
    const run = await startHarness(makeCtx(client), SANDBOX, "fix the test");

    expect(run.id).toBe("run_1");
    expect(run.result.status).toBe("queued");
    expect(calls).toEqual({ createRun: 1, getRun: 0, getRunChanges: 0 });
    // Nothing captured yet on a live handle.
    expect(run.changes.files).toEqual([]);
  });

  it("rejects when the sandbox handle has no harness", async () => {
    const { client } = makeStub({});
    const handleWithoutHarness: SandboxInit = { id: "sbx_1", name: "t", status: "ready" };
    await expect(startHarness(makeCtx(client), handleWithoutHarness, "p")).rejects.toThrow(
      /no harness/,
    );
  });

  it("wait() settles the handle: polls to terminal, then fetches the captured changes", async () => {
    const { client, calls } = makeStub({
      getRun: () => wireRun("completed", { exitCode: 0 }),
    });
    const started = await startHarness(makeCtx(client), SANDBOX, "fix the test");

    const settled = await started.wait();
    expect(settled.result.status).toBe("completed");
    expect(settled.result.outcome).toBe("completed");
    expect(settled.changes.files).toEqual([{ path: "src/index.ts", change: "modified" }]);
    await expect(settled.changes.diff()).resolves.toBe(CHANGES.diff);
    expect(calls.getRunChanges).toBe(1);
  });
});

describe("harness.run()", () => {
  it("blocks until terminal and carries the captured changes inline", async () => {
    const { client, calls } = makeStub({
      getRun: () => wireRun("completed", { exitCode: 0 }),
    });
    const run = await runHarness(makeCtx(client), SANDBOX, "fix the test");

    expect(run.result.status).toBe("completed");
    expect(run.changes.files).toEqual([{ path: "src/index.ts", change: "modified" }]);
    await expect(run.changes.diff()).resolves.toBe(CHANGES.diff);
    expect(calls).toEqual({ createRun: 1, getRun: 1, getRunChanges: 1 });

    // Already settled: wait() must not refetch the changes.
    const settled = await run.wait();
    expect(settled.changes.files).toEqual(run.changes.files);
    expect(calls.getRunChanges).toBe(1);
  });
});
