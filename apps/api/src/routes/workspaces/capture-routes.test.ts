import {
  WorkspacesGroup,
  flushWorkspaceCaptureRequestSchema,
  workspaceCaptureReplannedSchema,
  workspaceCaptureStatusSchema,
  type FlushWorkspaceCaptureRequest,
  type ReplanWorkspaceCaptureRequest,
} from "@sealant/api-contracts";
import {
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Workspace,
  type WorkspaceAttemptRepoService,
  type WorkspaceAttemptSnapshot,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import {
  SealantRuntime,
  SealantUnexpectedError,
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type CaptureReplanReport,
  type SealantSession,
} from "@sealant/workspaces";
import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { flushWorkspaceCapture, replanWorkspaceCapture } from "./workspaces.module.js";

const REPORT: CaptureFlushReport = {
  epoch: 3,
  worktreeId: "wt_1",
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 2,
  uploadedBytes: 4096,
  registered: 2,
  fenced: false,
  paused: false,
  refused: [],
};

/**
 * A capture-sourced workspace with a ready runtime, over fake repositories, whose daemon records
 * every flush request it is sent. The narrowing casts are test-only: each fake implements only
 * what the flush route reads.
 */
const flushHarness = (
  report: CaptureFlushReport = REPORT,
  options: {
    /** The first flush's connection closes before its answer (a FINAL's sweep killed the relay). */
    readonly firstFlushClosed?: boolean;
    /** The owner map the workspace's executor was launched with. */
    readonly ownerMap?: unknown;
  } = {},
) => {
  const flushRequests: Array<CaptureFlushRequest | undefined> = [];
  const calls: string[] = [];
  const recorded: Array<{ runId: string; status: Readonly<Record<string, unknown>> }> = [];
  const fences: string[] = [];
  const workspace = { id: "ws_1", ownerUserId: "usr_owner", latestRunId: "run_1" } as Workspace;
  const spec = {
    sources: {
      workspace: {
        kind: "capture",
        endpoint: "https://mend.example.com/session/s1",
        worktreeId: "wt_1",
        harnessHome: "/home/sealant/.claude",
        ...(options.ownerMap === undefined ? {} : { ownerMap: options.ownerMap }),
      },
    },
    harness: { id: "claude-code" },
  };
  const daemon = {
    captureFlush: (request?: CaptureFlushRequest) => {
      flushRequests.push(request);
      calls.push("flush");
      if (options.firstFlushClosed === true && calls.length === 1) {
        return Effect.fail(
          new SealantUnexpectedError({
            operation: "captureFlush",
            message: "connection closed",
            cause: new Error("connection closed"),
          }),
        );
      }
      return Effect.succeed(report);
    },
    captureStatus: () => {
      calls.push("status");
      return Effect.succeed(report);
    },
    captureReplan: () => {
      calls.push("replan");
      return Effect.succeed(REPLANNED);
    },
  } as unknown as SealantSession;
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () =>
        Effect.succeed({ resolvedSpecPayload: spec } as unknown as WorkspaceAttemptSnapshot),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(WorkspaceBuildJobRepo, {
      getLatestJobByRunId: () => Effect.succeed(undefined),
    } as unknown as WorkspaceBuildJobRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () =>
        Effect.succeed({
          runId: "run_1",
          status: "ready",
          adapter: "docker",
          endpoint: "unix:///run/sealant/ws_1.sock",
          resourceId: "container_1",
        } as WorkspaceRuntimeInstance),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(daemon) }),
    // Every relayed answer is recorded against the run's executor (review 5 #3), under an
    // observation fence opened before it was asked for and resolved by the record (review 6 #5).
    Layer.mock(WorkspaceCaptureDrainRepo, {
      openObservation: (input) =>
        Effect.sync(() => {
          fences.push(`open ${input.token}`);
          return { openedAt: new Date() };
        }),
      closeObservation: (input) =>
        Effect.sync(() => {
          fences.push(`close ${input.token}`);
        }),
      recordStatus: (input) =>
        Effect.sync(() => {
          recorded.push({ runId: input.runId, status: input.status });
          fences.push(`record ${input.fence ?? "unfenced"}`);
          return true;
        }),
    }),
  );
  const flush = (payload: Omit<FlushWorkspaceCaptureRequest, "ownerUserId">) =>
    Effect.runPromise(
      flushWorkspaceCapture({
        workspaceId: "ws_1",
        payload: { ownerUserId: "usr_owner", ...payload },
      }).pipe(Effect.provide(layer)),
    );
  const replan = (payload: Omit<ReplanWorkspaceCaptureRequest, "ownerUserId">) =>
    Effect.runPromise(
      Effect.result(
        replanWorkspaceCapture({
          workspaceId: "ws_1",
          payload: { ownerUserId: "usr_owner", ...payload },
        }).pipe(Effect.provide(layer)),
      ),
    );
  return { flush, replan, flushRequests, calls, recorded, fences };
};

const REPLANNED: CaptureReplanReport = {
  worktreeId: "wt_1",
  epoch: 4,
  filesWritten: 1,
  bytesWritten: 10,
  filesSkipped: 0,
  bytesSkipped: 0,
  removed: 0,
  unchanged: false,
};

/**
 * Route pins for the synchronous capture commands (sealantd ADR-0015 `capture.flush`, 0.15
 * `capture.replan`): the paths the SDK posts to, and that the daemon session's report — what the
 * handler returns verbatim — is exactly what the contract's success schema admits, optional
 * fields included.
 */
describe("workspace capture routes", () => {
  it("mount status as a GET on the workspace's capture path", () => {
    const status = WorkspacesGroup.endpoints["getWorkspaceCaptureStatus"];
    expect(status?.method).toBe("GET");
    expect(status?.path).toBe("/:workspaceId/capture");
  });

  it("mount flush and replan as POSTs under the workspace's capture path", () => {
    const flush = WorkspacesGroup.endpoints["flushWorkspaceCapture"];
    const replan = WorkspacesGroup.endpoints["replanWorkspaceCapture"];
    expect(flush?.method).toBe("POST");
    expect(flush?.path).toBe("/:workspaceId/capture/flush");
    expect(replan?.method).toBe("POST");
    expect(replan?.path).toBe("/:workspaceId/capture/replan");
  });

  it("answer flush and status with the session's capture status as-is", () => {
    const decode = Schema.decodeUnknownSync(workspaceCaptureStatusSchema);
    const minimal: CaptureFlushReport = {
      epoch: 3,
      worktreeId: "wt_1",
      pending: 0,
      stagedBytes: 0,
      uploadedObjects: 2,
      uploadedBytes: 4096,
      registered: 2,
      fenced: false,
      paused: false,
      refused: [],
    };
    expect(decode(minimal)).toEqual(minimal);
    const full: CaptureFlushReport = {
      ...minimal,
      headN: 7,
      lastSnapUnixMs: 1_757_760_000_000,
      refused: ["bulk"],
    };
    expect(decode(full)).toEqual(full);
    // An older control plane answers without `refused`; the reserved byte counts decode when set.
    const { refused: _refused, ...older } = minimal;
    expect(decode(older)).toEqual(older);
    expect(decode({ ...minimal, pendingBytes: 1024, pendingBulk: 1 })).toMatchObject({
      pendingBytes: 1024,
      pendingBulk: 1,
    });
  });

  it("answer flush and status with every field a newer daemon reports, and none it does not", () => {
    const decode = Schema.decodeUnknownSync(workspaceCaptureStatusSchema);
    const encode = Schema.encodeSync(workspaceCaptureStatusSchema);
    const failing: CaptureFlushReport = {
      ...REPORT,
      pending: 0,
      pendingBulk: 1,
      pendingBytes: 2048,
      complete: false,
      incompleteReason: "snapshot-failed",
      unreadable: 3,
      carried: 2,
      unreadablePaths: ["tree/a/deep", ".git/index.lock", "harness/x"],
      registerRefused: "missing-objects",
      registerRefusedN: 9,
      registerMissing: ["obj/ab12"],
      registerRefusals: 4,
      repairing: true,
      bulkBuilding: true,
      snaps: [
        {
          class: "small",
          snapsFailed: 12,
          lastSnapError: "File name too long (os error 36)",
          snapFailingSinceUnixMs: 1_757_760_000_000,
        },
        { class: "bulk", snapsFailed: 0 },
      ],
      lastSnapError: "File name too long (os error 36)",
      snapFailingSinceUnixMs: 1_757_760_000_000,
      snapsFailed: 12,
      origin: {
        epoch: 3,
        launch: "launch-1",
        bootId: "boot-1",
        bootGeneration: 1,
        observation: 12,
        headN: 7,
      },
      overdue: {
        step: "small snap › git cat-file --batch-check",
        startedUnixMs: 1_757_760_000_000,
        runningMs: 95_000,
        boundMs: 60_000,
      },
    };
    // The handler returns the session's report verbatim: the success schema neither drops nor
    // rewrites any of it on the way out, and a client decodes it back whole.
    expect(encode(failing)).toEqual(failing);
    expect(decode(encode(failing))).toEqual(failing);
    // A daemon on the pinned wire reports none of them: absent, never defaulted.
    const pinned = decode(encode(REPORT));
    expect(pinned).toEqual(REPORT);
    expect("snaps" in pinned).toBe(false);
    expect("lastSnapError" in pinned).toBe(false);
    expect("unreadable" in pinned).toBe(false);
    expect("bulkBuilding" in pinned).toBe(false);
  });

  it("flush answers the daemon's snap failure to the caller", async () => {
    const failing: CaptureFlushReport = {
      ...REPORT,
      complete: false,
      incompleteReason: "snapshot-failed",
      snaps: [
        { class: "small", snapsFailed: 3, lastSnapError: "File name too long (os error 36)" },
      ],
      lastSnapError: "File name too long (os error 36)",
      snapsFailed: 3,
    };
    const h = flushHarness(failing);
    expect(await h.flush({ kind: "final" })).toEqual(failing);
    // Recorded against the run's executor before it is returned (review 5 #3), the fence opened
    // before the request resolved by the record (review 6 #5).
    expect(h.recorded).toEqual([{ runId: "run_1", status: { ...failing } }]);
    expect(h.fences).toHaveLength(2);
    expect(h.fences[0]?.startsWith("open ")).toBe(true);
    expect(h.fences[1]).toBe(h.fences[0]?.replace("open ", "record "));
  });

  it("reject a snaps entry of an unknown class or without its failed count", () => {
    const decode = Schema.decodeUnknownSync(workspaceCaptureStatusSchema);
    expect(() => decode({ ...REPORT, snaps: [{ class: "medium", snapsFailed: 1 }] })).toThrow();
    expect(() => decode({ ...REPORT, snaps: [{ class: "small" }] })).toThrow();
  });

  it("answer replan with the session's replan report as-is", () => {
    const decode = Schema.decodeUnknownSync(workspaceCaptureReplannedSchema);
    const minimal: CaptureReplanReport = {
      worktreeId: "wt_2",
      epoch: 4,
      filesWritten: 9,
      bytesWritten: 213_000,
      filesSkipped: 418,
      bytesSkipped: 1_510_000,
      removed: 1,
      unchanged: false,
    };
    expect(decode(minimal)).toEqual(minimal);
    const full: CaptureReplanReport = { ...minimal, headN: 7, headCaptureId: "cap_7" };
    expect(decode(full)).toEqual(full);
    expect(() => decode({ ...minimal, worktreeId: "" })).toThrow();
  });
});

describe("workspace capture flush request", () => {
  const decode = Schema.decodeUnknownSync(flushWorkspaceCaptureRequestSchema);

  it("accepts the owner alone, and a kind, deadline and grace", () => {
    expect(decode({ ownerUserId: "usr_1" })).toEqual({ ownerUserId: "usr_1" });
    expect(
      decode({ ownerUserId: "usr_1", kind: "final", deadlineMs: 55_000, graceMs: 30_000 }),
    ).toEqual({ ownerUserId: "usr_1", kind: "final", deadlineMs: 55_000, graceMs: 30_000 });
    expect(decode({ ownerUserId: "usr_1", kind: "suspend" })).toMatchObject({ kind: "suspend" });
  });

  it("rejects an unknown kind and a deadline or grace that is not a positive integer", () => {
    expect(() => decode({ ownerUserId: "usr_1", kind: "terminate" })).toThrow();
    for (const bad of [0, -1, 1.5, "60000"]) {
      expect(() => decode({ ownerUserId: "usr_1", deadlineMs: bad })).toThrow();
      expect(() => decode({ ownerUserId: "usr_1", graceMs: bad })).toThrow();
    }
  });

  it("forwards kind, deadline and grace to the daemon, and asks for suspend by default", async () => {
    const h = flushHarness();
    expect(await h.flush({ kind: "final", deadlineMs: 55_000, graceMs: 30_000 })).toEqual(REPORT);
    await h.flush({ kind: "final" });
    await h.flush({});
    await h.flush({ deadlineMs: 10_000 });
    expect(h.flushRequests).toEqual([
      { kind: "final", deadlineMs: 55_000, graceMs: 30_000 },
      { kind: "final" },
      { kind: "suspend" },
      { kind: "suspend", deadlineMs: 10_000 },
    ]);
  });

  it("answers a FINAL whose connection closed under it with the status read again (e2e 6)", async () => {
    // e2e 6: the FINAL's sweep killed the `docker exec … socat` bridge that carried it, and every
    // stop answered `refused: connection closed`. The daemon had concluded; its status says so.
    const saved: CaptureFlushReport = { ...REPORT, complete: true };
    const h = flushHarness(saved, { firstFlushClosed: true });
    expect(await h.flush({ kind: "final" })).toEqual(saved);
    expect(h.calls).toEqual(["flush", "status"]);
  });
});

describe("a standby's claim names the owner map it needs (sealant#333 review P2-2)", () => {
  const ownerMap = {
    gid: 40000,
    worktreeUid: 40012,
    people: [
      { id: "acct_a", uid: 40012 },
      { id: "acct_b", uid: 40031 },
    ],
  };

  it("re-plans when the executor was launched with that map, in any order of people", async () => {
    const h = flushHarness(REPORT, { ownerMap });
    const answer = await h.replan({
      expectedOwnerMap: { ...ownerMap, people: ownerMap.people.toReversed() },
    });
    expect(Result.isSuccess(answer)).toBe(true);
    expect(h.calls).toEqual(["replan"]);
  });

  it("refuses another map, and none where one was expected, before the daemon is reached", async () => {
    for (const [launched, expected] of [
      [ownerMap, { ...ownerMap, people: ownerMap.people.slice(0, 1) }],
      [ownerMap, { ...ownerMap, worktreeUid: 40031 }],
      [undefined, ownerMap],
      [ownerMap, null],
    ] as const) {
      const h = flushHarness(REPORT, { ownerMap: launched });
      const answer = await h.replan({ expectedOwnerMap: expected });
      expect(Result.isFailure(answer)).toBe(true);
      if (Result.isFailure(answer)) {
        expect(answer.failure).toMatchObject({
          _tag: "WorkspaceConflictError",
          code: "owner-map-mismatch",
        });
      }
      expect(h.calls).toEqual([]);
    }
  });

  it("re-plans a standby launched with none when none is expected, and compares nothing unasked", async () => {
    const none = flushHarness(REPORT);
    expect(Result.isSuccess(await none.replan({ expectedOwnerMap: null }))).toBe(true);
    const unasked = flushHarness(REPORT, { ownerMap });
    expect(Result.isSuccess(await unasked.replan({}))).toBe(true);
    expect([...none.calls, ...unasked.calls]).toEqual(["replan", "replan"]);
  });

  it("answers whether the executor booted under an owner map in its capture status", () => {
    const decode = Schema.decodeUnknownSync(workspaceCaptureStatusSchema);
    expect(decode({ ...REPORT, ownerMap: true }).ownerMap).toBe(true);
    expect("ownerMap" in decode(REPORT)).toBe(false);
  });
});
