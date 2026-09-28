/**
 * `stop({ discardUnsaved: true })`: the owner's explicit, audited way to end a workspace whose
 * unsaved captures a drain would otherwise keep forever. The request is recorded (who, when)
 * before the stop is enqueued, and it is accepted on a workspace whose stop was already recorded
 * (the kept one). A plain stop of such a workspace stays a no-op.
 */
import {
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Workspace,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspaceLifecyclePublisherService } from "../../services/control-plane-capabilities.js";
import { mapWorkspaceCaptureDrain, stopWorkspace } from "./workspaces.module.js";

const now = new Date("2026-09-27T12:00:00.000Z");

const harness = (status: Workspace["status"]) => {
  const discards: Array<{ runId: string; requestedBy: string }> = [];
  const stops: string[] = [];
  const statuses: string[] = [];
  const workspace = {
    id: "ws_1",
    ownerUserId: "user_owner",
    status,
    latestRunId: "run_1",
  } as Workspace;
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
      setWorkspaceStatus: (input: { status: string }) => {
        statuses.push(input.status);
        return Effect.succeed(workspace);
      },
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () =>
        Effect.succeed({ runId: "run_1", status: "ready" } as WorkspaceRuntimeInstance),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceCaptureDrainRepo, {
      requestDiscard: (input: { runId: string; requestedBy: string }) => {
        discards.push(input);
        return Effect.succeed({} as WorkspaceCaptureDrain);
      },
    } as unknown as WorkspaceCaptureDrainRepoService),
    Layer.succeed(WorkspaceLifecyclePublisherService, {
      publishStopRequested: ({ runId }) => {
        stops.push(runId);
        return Promise.resolve();
      },
    }),
  );
  const stop = (payload: { ownerUserId: string; discardUnsaved?: boolean }) =>
    Effect.runPromise(stopWorkspace({ workspaceId: "ws_1", payload }).pipe(Effect.provide(layer)));
  return { stop, discards, stops, statuses };
};

describe("stopWorkspace · discardUnsaved", () => {
  it("records who discarded the unsaved captures, then enqueues the stop", async () => {
    const h = harness("ready");
    await h.stop({ ownerUserId: "user_owner", discardUnsaved: true });
    expect(h.discards).toEqual([{ runId: "run_1", requestedBy: "user_owner" }]);
    expect(h.stops).toEqual(["run_1"]);
  });

  it("ends a workspace whose stop was already recorded and a drain kept running", async () => {
    const h = harness("stopped");
    await h.stop({ ownerUserId: "user_owner" });
    expect(h.stops).toEqual([]);
    await h.stop({ ownerUserId: "user_owner", discardUnsaved: true });
    expect(h.discards).toHaveLength(1);
    expect(h.stops).toEqual(["run_1"]);
  });

  it("refuses anyone but the owner", async () => {
    const h = harness("stopped");
    await expect(h.stop({ ownerUserId: "someone_else", discardUnsaved: true })).rejects.toThrow(
      /not found/,
    );
    expect(h.discards).toEqual([]);
  });

  it("reports the audit on the workspace's captureDrain", () => {
    expect(
      mapWorkspaceCaptureDrain({
        runId: "run_1",
        state: "discarded",
        detail: "unsaved captures discarded",
        observedAt: now,
        preservationStartsAt: null,
        discardRequestedAt: now,
        discardRequestedBy: "user_owner",
      } as WorkspaceCaptureDrain),
    ).toEqual({
      state: "discarded",
      detail: "unsaved captures discarded",
      observedAt: now.toISOString(),
      discard: { requestedBy: "user_owner", requestedAt: now.toISOString() },
    });
  });
});
