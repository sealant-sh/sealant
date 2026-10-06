/**
 * Unit tests for `workspace.exec()` against a stub contract client (no live API): the result must be
 * assembled from the record (exit code from the run, stdout/stderr from scrollback keyed by the
 * command's processId), a NONZERO exit must RESOLVE (it is the check datum), and a non-completed run
 * must REJECT (the machinery broke — the exit code cannot be trusted).
 */
import type {
  ExecWorkspaceRequest,
  Run as WireRun,
  RunScrollbackResponse,
  RunTimelineResponse,
} from "@sealant/api-contracts";
import {
  BudgetExceededError,
  RunInternalServerError,
  RunNotFoundError,
} from "@sealant/api-contracts";
import { Effect } from "effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import { execWorkspace, nextExecPollMs } from "./effect/exec-workspace.js";
import { READ_RETRY_BUDGET_MS } from "./effect/read-retry.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import { SealantApiError } from "./errors.js";
import type { SdkContext } from "./facade/context.js";
import type { WorkspaceInit } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";

const wireRun = (status: WireRun["status"], overrides: Partial<WireRun> = {}): WireRun => ({
  runId: "run_exec_1",
  workspaceId: "ws_1",
  ownerUserId: "usr_local",
  harnessId: "exec",
  mode: "one-shot",
  status,
  createdAt: "2026-07-06T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
  ...overrides,
});

const timelineWith = (executable: string, processId: string): RunTimelineResponse => ({
  items: [
    {
      eventId: "evt_1",
      sequence: "1",
      kind: "processStarted",
      occurredAt: "1",
      summary: `$ ${executable}`,
      ref: { executable, args: [] },
      processId,
      captureMethod: 1,
      confidence: 1,
    },
  ],
});

const scrollback = (content: string): Omit<RunScrollbackResponse, "processId" | "stream"> => ({
  byteCount: Buffer.byteLength(content),
  contentBase64: Buffer.from(content, "utf8").toString("base64"),
});

interface StubHandlers {
  readonly execWorkspace?: (payload: ExecWorkspaceRequest) => WireRun;
  readonly getRun?: () => WireRun;
  /** A read that may fail, in place of `getRun`. */
  readonly readRun?: () => Effect.Effect<WireRun, unknown>;
  readonly stdout?: string;
  readonly stderr?: string;
}

const makeStub = (
  handlers: StubHandlers,
): { client: ControlPlaneClient; requests: ExecWorkspaceRequest[] } => {
  const requests: ExecWorkspaceRequest[] = [];
  const workspaces = {
    execWorkspace: ({ payload }: { payload: ExecWorkspaceRequest }) => {
      requests.push(payload);
      return Effect.sync(() => (handlers.execWorkspace ?? (() => wireRun("queued")))(payload));
    },
  };
  const runs = {
    getRun: () =>
      handlers.readRun?.() ??
      Effect.sync(() => (handlers.getRun ?? (() => wireRun("completed")))()),
    getRunTimeline: () => Effect.sync(() => timelineWith("pnpm", "proc_1")),
    getRunScrollback: ({ query }: { query: { stream: "stdout" | "stderr" } }) =>
      Effect.sync(() => ({
        processId: "proc_1",
        stream: query.stream,
        ...scrollback(
          query.stream === "stdout" ? (handlers.stdout ?? "") : (handlers.stderr ?? ""),
        ),
      })),
    getRunChanges: () => Effect.sync(() => ({ files: [], diff: "" })),
  };
  const client = { workspaces, runs } as unknown as ControlPlaneClient;
  return { client, requests };
};

const makeCtx = (client: ControlPlaneClient): SdkContext => ({
  runtime: {
    run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      Effect.runPromise(
        Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
      ),
    dispose: () => Promise.resolve(),
  } satisfies SdkRuntime,
  config: resolveInternalConfig({ baseUrl: "http://stub.invalid" }),
});

const WORKSPACE: WorkspaceInit = { id: "ws_1", name: "t", status: "ready" };

/** Runs an exec to its end on the fake clock; resolves with its outcome, never rejects. */
const settle = async <A>(promise: Promise<A>, ms: number) => {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
};

describe("workspace.exec()", () => {
  it("assembles exit code, stdout, and stderr from the record", async () => {
    const { client, requests } = makeStub({
      getRun: () => wireRun("completed", { exitCode: 0 }),
      stdout: "42 passed\n",
      stderr: "",
    });

    const result = await execWorkspace(makeCtx(client), WORKSPACE, ["pnpm", "test"], {
      cwd: "/workspace/repo/pkg",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("42 passed\n");
    expect(result.stderr).toBe("");
    expect(result.run.id).toBe("run_exec_1");
    // The request carries the single command with argv split and cwd through — references only.
    expect(requests).toEqual([
      {
        ownerUserId: "usr_local",
        commands: [{ executable: "pnpm", args: ["test"], cwd: "/workspace/repo/pkg" }],
      },
    ]);
  });

  it("RESOLVES on a nonzero exit — the exit code is the check datum", async () => {
    const { client } = makeStub({
      getRun: () => wireRun("completed", { exitCode: 1 }),
      stderr: "1 failed\n",
    });

    const result = await execWorkspace(makeCtx(client), WORKSPACE, ["pnpm", "test"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("1 failed\n");
  });

  it("REJECTS when the run did not complete (machinery broke, exit code untrustworthy)", async () => {
    const { client } = makeStub({
      getRun: () => wireRun("failed", { errorMessage: "transport closed; check run aborted." }),
    });

    await expect(execWorkspace(makeCtx(client), WORKSPACE, ["pnpm", "test"])).rejects.toThrow(
      /did not complete.*transport closed/,
    );
  });

  it("reads a run every 25 ms for its first half second, then less often", () => {
    const waits: number[] = [];
    let elapsed = 0;
    let wait: number | undefined;
    while (elapsed < 4_000) {
      wait = nextExecPollMs(wait, elapsed);
      waits.push(wait);
      elapsed += wait;
    }
    // 20 reads 25 ms apart; until 2 s, doubling from 50 ms up to 250 ms; then up to 500 ms.
    expect(waits.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 25));
    expect(waits.slice(20, 30)).toEqual([50, 100, 200, 250, 250, 250, 250, 250, 500, 500]);
  });

  describe("on a fake clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sees a run that ends at 90 ms at the 100 ms read", async () => {
      const reads: number[] = [];
      const startedAt = Date.now();
      const { client } = makeStub({
        getRun: () => {
          reads.push(Date.now() - startedAt);
          return Date.now() - startedAt < 90 ? wireRun("running") : wireRun("completed");
        },
      });
      const outcome = await settle(execWorkspace(makeCtx(client), WORKSPACE, ["true"]), 1_000);
      expect(outcome.ok).toBe(true);
      // Doubling read it at 25, 75 and 175 ms.
      expect(reads).toEqual([25, 50, 75, 100]);
    });

    it("reads again after a 429, when its Retry-After says, and the exec goes on", async () => {
      const reads: number[] = [];
      const startedAt = Date.now();
      const { client } = makeStub({
        readRun: () =>
          Effect.suspend(() => {
            reads.push(Date.now() - startedAt);
            if (reads.length === 5) {
              return Effect.fail(
                new BudgetExceededError({
                  message: "Request budget exceeded.",
                  budget: "principalRequestsPerMinute",
                  limit: 12_000,
                  retryAfterSeconds: 2,
                }),
              );
            }
            return Effect.succeed(
              Date.now() - startedAt < 3_000 ? wireRun("running") : wireRun("completed"),
            );
          }),
      });
      const outcome = await settle(execWorkspace(makeCtx(client), WORKSPACE, ["true"]), 10_000);
      expect(outcome.ok).toBe(true);
      // The refused read at 125 ms is read again 2 s later, not before.
      expect(reads[4]).toBe(125);
      expect(reads[5]).toBe(2_125);
    });

    it("reads again after a lost request or a 5xx the contract does not name", async () => {
      const request = HttpClientRequest.get("http://stub.invalid/v1/runs/run_exec_1");
      const failures: unknown[] = [
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "socket hang up" }),
        }),
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request,
            response: HttpClientResponse.fromWeb(
              request,
              new Response("bad gateway", { status: 502, headers: { "retry-after": "1" } }),
            ),
          }),
        }),
        new RunInternalServerError({ message: "Failed to load run." }),
      ];
      const reads: number[] = [];
      const startedAt = Date.now();
      const { client } = makeStub({
        readRun: () =>
          Effect.suspend(() => {
            reads.push(Date.now() - startedAt);
            const failure = failures.shift();
            return failure === undefined
              ? Effect.succeed(wireRun("completed"))
              : Effect.fail(failure);
          }),
      });
      const outcome = await settle(execWorkspace(makeCtx(client), WORKSPACE, ["true"]), 10_000);
      expect(outcome.ok).toBe(true);
      // 100 ms after the lost request, Retry-After's 1 s after the 502, 400 ms after the 500.
      expect(reads).toEqual([25, 125, 1_125, 1_525]);
    });

    it("fails a read no retry can fix at once, naming the run", async () => {
      let reads = 0;
      const { client } = makeStub({
        readRun: () =>
          Effect.suspend(() => {
            reads += 1;
            return Effect.fail(new RunNotFoundError({ message: "Run not found: run_exec_1" }));
          }),
      });
      const outcome = await settle(execWorkspace(makeCtx(client), WORKSPACE, ["true"]), 1_000);
      expect(reads).toBe(1);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBeInstanceOf(SealantApiError);
      expect(String(outcome.error)).toMatch(/exec run run_exec_1 failed: Run not found/);
    });

    it("gives up after a bounded wait, naming the run and the last status", async () => {
      let reads = 0;
      const { client } = makeStub({
        readRun: () =>
          Effect.suspend(() => {
            reads += 1;
            return Effect.fail(new RunInternalServerError({ message: "Failed to load run." }));
          }),
      });
      const outcome = await settle(
        execWorkspace(makeCtx(client), WORKSPACE, ["true"]),
        READ_RETRY_BUDGET_MS + 5_000,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBeInstanceOf(SealantApiError);
      if (!(outcome.error instanceof SealantApiError)) return;
      expect(outcome.error.status).toBe(500);
      expect(outcome.error.message).toMatch(
        /^Reading the state of exec run run_exec_1 failed \(read \d+ times\): Failed to load run\.$/,
      );
      // 100, 200, 400, 800, 1 600 ms, then 2 s at a time, within the minute.
      expect(reads).toBe(6 + Math.floor((READ_RETRY_BUDGET_MS - 3_100) / 2_000));
    });
  });

  it("passes on that the run's changes were not read, never an apparently empty change", async () => {
    const { client } = makeStub({ getRun: () => wireRun("completed", { exitCode: 0 }) });
    const unread = {
      ...client,
      runs: {
        ...client.runs,
        getRunChanges: () =>
          Effect.sync(() => ({
            files: [],
            diff: "",
            available: false,
            unavailableReason: "reading the run's changes failed",
          })),
      },
    } as unknown as ControlPlaneClient;
    const result = await execWorkspace(makeCtx(unread), WORKSPACE, ["true"]);
    expect(result.run.changes.available).toBe(false);
    expect(result.run.changes.unavailableReason).toBe("reading the run's changes failed");

    // A control plane older than the field answers without it: the changes read as available.
    const older = await execWorkspace(makeCtx(client), WORKSPACE, ["true"]);
    expect(older.run.changes.available).toBe(true);
  });

  it("rejects an empty argv before any request is made", async () => {
    const { client, requests } = makeStub({});
    await expect(execWorkspace(makeCtx(client), WORKSPACE, [])).rejects.toThrow(
      /at least the executable/,
    );
    expect(requests).toEqual([]);
  });
});
