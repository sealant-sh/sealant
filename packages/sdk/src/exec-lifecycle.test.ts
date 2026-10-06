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
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import { execWorkspace, nextExecPollMs } from "./effect/exec-workspace.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
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
    getRun: () => Effect.sync(() => (handlers.getRun ?? (() => wireRun("completed")))()),
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
    while (elapsed < 3_000) {
      wait = nextExecPollMs(wait, elapsed);
      waits.push(wait);
      elapsed += wait;
    }
    // 20 reads 25 ms apart, then 50, 100, 200, 400, and 500 ms from then on.
    expect(waits.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 25));
    expect(waits.slice(20, 26)).toEqual([50, 100, 200, 400, 500, 500]);
  });

  it("sees a quick run within one 25 ms read of it ending", async () => {
    const reads: number[] = [];
    const startedAt = Date.now();
    const { client } = makeStub({
      getRun: () => {
        reads.push(Date.now());
        // The run ends 90 ms after it was registered: doubling read it at 25, 75 and 175 ms.
        return Date.now() - startedAt < 90 ? wireRun("running") : wireRun("completed");
      },
    });
    await execWorkspace(makeCtx(client), WORKSPACE, ["true"]);
    const seenAt = (reads.at(-1) ?? startedAt) - startedAt;
    expect(seenAt).toBeGreaterThanOrEqual(90);
    expect(seenAt).toBeLessThan(170);
    for (const [index, at] of reads.slice(1).entries()) {
      expect(at - (reads[index] ?? at)).toBeGreaterThanOrEqual(20);
    }
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
