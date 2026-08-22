import type { WorkspaceRuntimeInstance } from "@sealant/db";
import { describe, expect, it, vi } from "vitest";

import type { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import { reapOrphanedKubernetesResources } from "./reap-orphaned-kubernetes-resources.js";

vi.mock("@sealant/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sealant/db")>();
  const { Effect, Layer } = await import("effect");
  const rows = new Map<string, Partial<WorkspaceRuntimeInstance>>([
    ["run-live", { runId: "run-live", status: "ready", resourceId: "ws-run-live-aaaaaa" }],
    [
      "run-stopped",
      { runId: "run-stopped", status: "stopped", resourceId: "ws-run-stopped-bbbbbb" },
    ],
  ]);
  return {
    ...actual,
    WorkspaceRuntimeInstanceRepoLive: Layer.succeed(actual.WorkspaceRuntimeInstanceRepo, {
      upsertRuntimeInstance: () => Effect.die("unused"),
      markStopped: () => Effect.die("unused"),
      getRuntimeInstanceByRunId: () => Effect.die("unused"),
      listRuntimeInstancesByRunIds: (ids: readonly string[]) =>
        Effect.succeed(new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id)]] : [])))),
      listRunningInstances: () => Effect.die("unused"),
    } as never),
  };
});

describe("reapOrphanedKubernetesResources", () => {
  it("stops pods whose run has no row or a stopped row, and leaves live runs alone", async () => {
    const stop = vi.fn(async (input: { resourceId: string }) => ({
      adapter: "k8s" as const,
      resourceId: input.resourceId,
      outcome: "stopped" as const,
    }));
    const adapter = {
      listManagedWorkspaces: async () => [
        { runId: "run-live", resourceId: "ws-run-live-aaaaaa" },
        { runId: "run-stopped", resourceId: "ws-run-stopped-bbbbbb" },
        { runId: "run-gone", resourceId: "ws-run-gone-cccccc" },
      ],
      stop,
    } as unknown as KubernetesRuntimeAdapter;

    const reaped = await reapOrphanedKubernetesResources({ db: {} as never, adapter });

    expect(reaped).toBe(2);
    expect(stop.mock.calls.map(([input]) => input.resourceId).toSorted()).toEqual([
      "ws-run-gone-cccccc",
      "ws-run-stopped-bbbbbb",
    ]);
  });
});
