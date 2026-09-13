/**
 * Unit tests for the workspace capture surface (`workspace.capture.flush()` / `.replan()`): the
 * ops' call shapes and the facade's wire → public mapping, driven against a stub contract client
 * (no live API).
 */
import type { WorkspaceCaptureReplanned, WorkspaceCaptureStatus } from "@sealant/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";

const STATUS: WorkspaceCaptureStatus = {
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

const REPLANNED: WorkspaceCaptureReplanned = {
  worktreeId: "wt_2",
  epoch: 4,
  filesWritten: 9,
  bytesWritten: 213_000,
  filesSkipped: 418,
  bytesSkipped: 1_510_000,
  removed: 1,
  unchanged: false,
};

interface StubCalls {
  flush: unknown[];
  replan: unknown[];
}

interface StubHandlers {
  readonly flush?: () => WorkspaceCaptureStatus;
  readonly replan?: () => WorkspaceCaptureReplanned;
}

// The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
const makeStub = (handlers: StubHandlers): { client: ControlPlaneClient; calls: StubCalls } => {
  const calls: StubCalls = { flush: [], replan: [] };
  const workspaces = {
    flushWorkspaceCapture: (request: unknown) => {
      calls.flush.push(request);
      return Effect.sync(() => (handlers.flush ?? (() => STATUS))());
    },
    replanWorkspaceCapture: (request: unknown) => {
      calls.replan.push(request);
      return Effect.sync(() => (handlers.replan ?? (() => REPLANNED))());
    },
  };
  const client = { workspaces } as unknown as ControlPlaneClient;
  return { client, calls };
};

const makeCtx = (client: ControlPlaneClient): SdkContext => ({
  runtime: {
    run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      // The stub provides all of SdkServices; see run-lifecycle.test.ts for the same narrowing.
      Effect.runPromise(
        Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
      ),
    dispose: () => Promise.resolve(),
  } satisfies SdkRuntime,
  config: resolveInternalConfig({ baseUrl: "http://stub.invalid" }),
});

const workspaceFor = (client: ControlPlaneClient) =>
  makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

describe("workspace.capture", () => {
  it("flush() posts the owner to the workspace's flush endpoint and maps the status", async () => {
    const { client, calls } = makeStub({});
    const status = await workspaceFor(client).capture.flush();
    expect(calls.flush).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: "usr_local" } },
    ]);
    expect(status).toEqual(STATUS);
    expect("headN" in status).toBe(false);
  });

  it("replan() posts the owner to the workspace's replan endpoint and maps the counts", async () => {
    const { client, calls } = makeStub({});
    const replanned = await workspaceFor(client).capture.replan();
    expect(calls.replan).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: "usr_local" } },
    ]);
    expect(replanned).toEqual(REPLANNED);
    expect("headN" in replanned).toBe(false);
    expect("headCaptureId" in replanned).toBe(false);
  });

  it("replan() keeps the head fields and the idempotent flag when the daemon reports them", async () => {
    const { client } = makeStub({
      replan: () => ({
        ...REPLANNED,
        headN: 7,
        headCaptureId: "cap_7",
        filesWritten: 0,
        bytesWritten: 0,
        removed: 0,
        unchanged: true,
      }),
    });
    const replanned = await workspaceFor(client).capture.replan();
    expect(replanned).toMatchObject({
      headN: 7,
      headCaptureId: "cap_7",
      filesWritten: 0,
      unchanged: true,
    });
  });
});
