import {
  LAUNCH_RETAINED_ERROR_CODE,
  WorkspaceAttemptRepo,
  WorkspaceRuntimeInstanceRepo,
  type UpsertWorkspaceRuntimeInstanceInput,
  type WorkspaceAttemptRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import { inMemoryCaptureDrainLedger, type CaptureDrainLedger } from "./capture-drain.js";
import { reapOrphanedKubernetesResourcesEffect } from "./reap-orphaned-kubernetes-resources.js";

const row = (
  runId: string,
  overrides: Partial<WorkspaceRuntimeInstance>,
): Partial<WorkspaceRuntimeInstance> => ({ runId, resourceId: `ws-${runId}`, ...overrides });

const harness = (input: {
  readonly rows: ReadonlyMap<string, Partial<WorkspaceRuntimeInstance>>;
  readonly pods: readonly string[];
  /** Source kind in each run's attempt snapshot; absent = no snapshot. */
  readonly snapshots?: ReadonlyMap<string, string>;
  readonly upsertFails?: boolean;
  readonly ledger?: CaptureDrainLedger;
}) => {
  const stop = vi.fn(async (request: { resourceId: string }) => ({
    adapter: "k8s" as const,
    resourceId: request.resourceId,
    outcome: "stopped" as const,
  }));
  const upserts: UpsertWorkspaceRuntimeInstanceInput[] = [];
  const adapter = {
    listManagedWorkspaces: async () =>
      input.pods.map((runId) => ({ runId, resourceId: `ws-${runId}` })),
    launchIdentityFor: (runId: string) => ({
      adapter: "k8s" as const,
      resourceId: `ws-${runId}`,
      reference: `ws-${runId}`,
      endpoint: `wss://ws-${runId}.sealant.svc:7443`,
    }),
    stop,
  } as unknown as KubernetesRuntimeAdapter;
  const instances = {
    listRuntimeInstancesByRunIds: (ids: readonly string[]) =>
      Effect.succeed(
        new Map(ids.flatMap((id) => (input.rows.has(id) ? [[id, input.rows.get(id)]] : []))),
      ),
    upsertRuntimeInstance: (request: UpsertWorkspaceRuntimeInstanceInput) => {
      if (input.upsertFails === true) {
        return Effect.die(new Error("violates foreign key constraint"));
      }
      upserts.push(request);
      return Effect.succeed({} as WorkspaceRuntimeInstance);
    },
  } as unknown as WorkspaceRuntimeInstanceRepoService;
  const attempts = {
    getAttemptSnapshotByRunId: (runId: string) => {
      const kind = input.snapshots?.get(runId);
      return Effect.succeed(
        kind === undefined ? undefined : { blueprintPayload: { sources: { workspace: { kind } } } },
      );
    },
  } as unknown as WorkspaceAttemptRepoService;
  const run = () =>
    Effect.runPromise(
      reapOrphanedKubernetesResourcesEffect({
        adapter,
        ...(input.ledger === undefined ? {} : { ledger: input.ledger }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkspaceRuntimeInstanceRepo, instances),
            Layer.succeed(WorkspaceAttemptRepo, attempts),
          ),
        ),
      ),
    );
  const stopped = () => stop.mock.calls.map(([request]) => request.resourceId).toSorted();
  return { run, stopped, upserts };
};

describe("reapOrphanedKubernetesResources", () => {
  it("stops pods whose row is stopped or failed, and leaves live and retained runs alone", async () => {
    const h = harness({
      rows: new Map([
        ["live", row("live", { status: "ready" })],
        ["stopped", row("stopped", { status: "stopped", sourceKind: "git" })],
        [
          "exited",
          row("exited", { status: "failed", errorCode: "runtime-exited", sourceKind: "git" }),
        ],
        ["retained", row("retained", { status: "failed", errorCode: LAUNCH_RETAINED_ERROR_CODE })],
      ]),
      pods: ["live", "stopped", "exited", "retained"],
    });

    expect(await h.run()).toBe(2);
    expect(h.stopped()).toEqual(["ws-exited", "ws-stopped"]);
  });

  it("stops a pod with no row when its attempt snapshot names a source that is not a capture", async () => {
    const h = harness({ rows: new Map(), pods: ["git"], snapshots: new Map([["git", "git"]]) });
    expect(await h.run()).toBe(1);
    expect(h.stopped()).toEqual(["ws-git"]);
  });

  it("records a pod with no row and no readable source as a retained launch instead of deleting it", async () => {
    // The launch's runtime-row write failed after the Pod came up: nothing says whether it holds
    // captures. It is recorded (so the retained-launch sweep drains it), never deleted here.
    const h = harness({ rows: new Map(), pods: ["unrecorded"] });

    expect(await h.run()).toBe(0);
    expect(h.stopped()).toEqual([]);
    expect(h.upserts).toEqual([
      expect.objectContaining({
        runId: "unrecorded",
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        adapter: "k8s",
        resourceId: "ws-unrecorded",
        endpoint: "wss://ws-unrecorded.sealant.svc:7443",
      }),
    ]);
  });

  it("keeps a failed capture Pod the exit reconciler retained (no completion evidence)", async () => {
    // Review 2 #3: the exit reconciler records the exit (`failed`, `runtime-exited`) and keeps
    // the Pod, whose emptyDir holds the staged captures; the orphan sweep must not delete it.
    const h = harness({
      rows: new Map([
        [
          "kept",
          row("kept", { status: "failed", errorCode: "runtime-exited", sourceKind: "capture" }),
        ],
      ]),
      pods: ["kept"],
      snapshots: new Map([["kept", "capture"]]),
    });
    expect(await h.run()).toBe(0);
    expect(h.stopped()).toEqual([]);
  });

  it("keeps a capture-sourced pod with no row when even recording it fails", async () => {
    const h = harness({
      rows: new Map(),
      pods: ["capture"],
      snapshots: new Map([["capture", "capture"]]),
      upsertFails: true,
    });
    expect(await h.run()).toBe(0);
    expect(h.stopped()).toEqual([]);
  });

  it("ends the drain record of a capture Pod it removes with evidence (review 3 #23)", async () => {
    // The retention and the sealed recovery token end with the executor, whichever path removed it.
    const ledger = inMemoryCaptureDrainLedger();
    Effect.runSync(ledger.markRetained("discarded", "executor exited"));
    const current = ledger.store.rows.get("discarded");
    if (current === undefined) throw new Error("no ledger row");
    // The owner discarded its unsaved captures (audited): the policy lets the Pod go.
    current.entry = { ...current.entry, discardRequested: { by: "user_owner", atMs: 1 } };
    const h = harness({
      rows: new Map([
        [
          "discarded",
          row("discarded", {
            status: "failed",
            errorCode: "runtime-exited",
            sourceKind: "capture",
          }),
        ],
      ]),
      pods: ["discarded"],
      ledger,
    });
    expect(await h.run()).toBe(1);
    expect(h.stopped()).toEqual(["ws-discarded"]);
    expect(ledger.store.rows.get("discarded")).toMatchObject({
      observation: { state: "stopped" },
      entry: expect.not.objectContaining({ retained: expect.anything() }),
    });
  });
});
