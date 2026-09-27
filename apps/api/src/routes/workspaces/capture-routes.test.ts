import {
  WorkspacesGroup,
  flushWorkspaceCaptureRequestSchema,
  workspaceCaptureReplannedSchema,
  workspaceCaptureStatusSchema,
  type FlushWorkspaceCaptureRequest,
} from "@sealant/api-contracts";
import {
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
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
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type CaptureReplanReport,
  type SealantSession,
} from "@sealant/workspaces";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { flushWorkspaceCapture } from "./workspaces.module.js";

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
const flushHarness = (report: CaptureFlushReport = REPORT) => {
  const flushRequests: Array<CaptureFlushRequest | undefined> = [];
  const workspace = { id: "ws_1", ownerUserId: "usr_owner", latestRunId: "run_1" } as Workspace;
  const spec = {
    sources: {
      workspace: {
        kind: "capture",
        endpoint: "https://mend.example.com/session/s1",
        worktreeId: "wt_1",
        harnessHome: "/home/sealant/.claude",
      },
    },
    harness: { id: "claude-code" },
  };
  const daemon = {
    captureFlush: (request?: CaptureFlushRequest) => {
      flushRequests.push(request);
      return Effect.succeed(report);
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
  );
  const flush = (payload: Omit<FlushWorkspaceCaptureRequest, "ownerUserId">) =>
    Effect.runPromise(
      flushWorkspaceCapture({
        workspaceId: "ws_1",
        payload: { ownerUserId: "usr_owner", ...payload },
      }).pipe(Effect.provide(layer)),
    );
  return { flush, flushRequests };
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
      lastSnapError: "File name too long (os error 36)",
      snapFailingSinceUnixMs: 1_757_760_000_000,
      snapsFailed: 12,
    };
    // The handler returns the session's report verbatim: the success schema neither drops nor
    // rewrites any of it on the way out, and a client decodes it back whole.
    expect(encode(failing)).toEqual(failing);
    expect(decode(encode(failing))).toEqual(failing);
    // A daemon on the pinned wire reports none of them: absent, never defaulted.
    const pinned = decode(encode(REPORT));
    expect(pinned).toEqual(REPORT);
    expect("lastSnapError" in pinned).toBe(false);
    expect("unreadable" in pinned).toBe(false);
    expect("bulkBuilding" in pinned).toBe(false);
  });

  it("flush answers the daemon's snap failure to the caller", async () => {
    const failing: CaptureFlushReport = {
      ...REPORT,
      complete: false,
      incompleteReason: "snapshot-failed",
      lastSnapError: "File name too long (os error 36)",
      snapsFailed: 3,
    };
    const h = flushHarness(failing);
    expect(await h.flush({ kind: "final" })).toEqual(failing);
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
});
