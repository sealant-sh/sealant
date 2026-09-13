import {
  WorkspacesGroup,
  workspaceCaptureReplannedSchema,
  workspaceCaptureStatusSchema,
} from "@sealant/api-contracts";
import type { CaptureFlushReport, CaptureReplanReport } from "@sealant/workspaces";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

/**
 * Route pins for the synchronous capture commands (sealantd ADR-0015 `capture.flush`, 0.15
 * `capture.replan`): the paths the SDK posts to, and that the daemon session's report — what the
 * handler returns verbatim — is exactly what the contract's success schema admits, optional
 * fields included.
 */
describe("workspace capture routes", () => {
  it("mount flush and replan as POSTs under the workspace's capture path", () => {
    const flush = WorkspacesGroup.endpoints["flushWorkspaceCapture"];
    const replan = WorkspacesGroup.endpoints["replanWorkspaceCapture"];
    expect(flush?.method).toBe("POST");
    expect(flush?.path).toBe("/:workspaceId/capture/flush");
    expect(replan?.method).toBe("POST");
    expect(replan?.path).toBe("/:workspaceId/capture/replan");
  });

  it("answer flush with the session's capture status as-is", () => {
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
    };
    expect(decode(minimal)).toEqual(minimal);
    const full: CaptureFlushReport = { ...minimal, headN: 7, lastSnapUnixMs: 1_757_760_000_000 };
    expect(decode(full)).toEqual(full);
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
