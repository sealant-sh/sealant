import type { PublishedWorkspaceImage, WorkspaceBuildJob } from "@sealant/db";
import { describe, expect, it, vi } from "vitest";

import type { RegistryClient } from "../registry/client.js";
import { reapWorkspaceImages } from "./reap-workspace-images.js";

const hoursAgo = (hours: number): Date => new Date(Date.UTC(2026, 8, 12, 12 - hours));

const image = (
  overrides: Partial<PublishedWorkspaceImage> & { readonly digest: string },
): PublishedWorkspaceImage => ({
  jobId: `job-${overrides.digest}`,
  runId: null,
  registryId: "default",
  publishedReference: "sealant-workspace-arch:plan-000000000000",
  repository: "wt-legacy",
  planHash: null,
  publishedAt: hoursAgo(1),
  ...overrides,
});

// Newest first, as the repository returns them.
const published: Array<PublishedWorkspaceImage> = [
  // Plan A, newest publish: the reuse target for plan A.
  image({ digest: "sha256:a2", planHash: "planA", runId: "run-live", publishedAt: hoursAgo(1) }),
  // Plan B, newest: retained (second distinct plan).
  image({ digest: "sha256:b1", planHash: "planB", publishedAt: hoursAgo(2) }),
  // Plan C, newest: retained (third distinct plan).
  image({ digest: "sha256:c1", planHash: "planC", publishedAt: hoursAgo(3) }),
  // Plan A, older publish: superseded by a2, no live workspace → candidate.
  image({ digest: "sha256:a1", planHash: "planA", runId: "run-stopped", publishedAt: hoursAgo(4) }),
  // Plan D: fourth distinct plan, beyond the retained three → candidate, unless a run needs it.
  image({ digest: "sha256:d1", planHash: "planD", runId: "run-running", publishedAt: hoursAgo(5) }),
  // Legacy publish without a plan hash, registry-style reference → candidate under its own repo.
  image({
    digest: "sha256:e1",
    publishedReference: "127.0.0.1:5000/wt-old/name:sdk-abc",
    repository: "wt-old/name",
    publishedAt: hoursAgo(6),
  }),
  // The same digest published twice: deleted once.
  image({ digest: "sha256:e1", jobId: "job-e1-again", publishedAt: hoursAgo(7) }),
];

vi.mock("@sealant/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sealant/db")>();
  const { Effect, Layer } = await import("effect");
  const jobByRun = new Map<string, Partial<WorkspaceBuildJob>>([
    ["run-live", { runId: "run-live", publishedDigest: "sha256:a2" }],
    ["run-running", { runId: "run-running", publishedDigest: "sha256:d1" }],
    ["run-stopped", { runId: "run-stopped", publishedDigest: "sha256:a1" }],
  ]);
  return {
    ...actual,
    WorkspaceRepoLive: Layer.succeed(actual.WorkspaceRepo, {
      listWorkspaces: (input: { statuses?: readonly string[] }) => {
        expect(input.statuses).toEqual(["queued", "running", "ready"]);
        return Effect.succeed([
          { id: "ws-live", status: "ready", latestRunId: "run-live" },
          { id: "ws-queued", status: "queued", latestRunId: null },
        ]);
      },
    } as never),
    WorkspaceRuntimeInstanceRepoLive: Layer.succeed(actual.WorkspaceRuntimeInstanceRepo, {
      listRunningInstances: () => Effect.succeed([{ runId: "run-running", status: "ready" }]),
    } as never),
    WorkspaceBuildJobRepoLive: Layer.succeed(actual.WorkspaceBuildJobRepo, {
      listPublishedImages: () => Effect.succeed(published),
      listLatestJobsByRunIds: (runIds: readonly string[]) =>
        Effect.succeed(
          new Map(runIds.flatMap((id) => (jobByRun.has(id) ? [[id, jobByRun.get(id)]] : []))),
        ),
    } as never),
  };
});

const store = (
  respond: (input: { repository: string; digest: string }) => "deleted" | "missing" | "in-use",
) => {
  const deleteImage = vi.fn(async (input: { repository: string; digest: string }) =>
    respond(input),
  );
  return { deleteImage, registryClient: { deleteImage } as unknown as RegistryClient };
};

describe("reapWorkspaceImages", () => {
  it("keeps live-run and retained-plan images and deletes the rest once each", async () => {
    const { deleteImage, registryClient } = store(() => "deleted");

    const summary = await reapWorkspaceImages({ db: {} as never, registryClient });

    expect(deleteImage.mock.calls.map(([input]) => input)).toEqual([
      { repository: "sealant-workspace-arch", digest: "sha256:a1" },
      { repository: "wt-old/name", digest: "sha256:e1" },
    ]);
    // a2 (live + plan A), b1, c1 (retained plans), d1 (running instance).
    expect(summary).toEqual({
      kept: 4,
      deleted: 2,
      inUse: 0,
      missing: 0,
      failed: 0,
      deferred: 0,
    });
  });

  it("honours the retained-plan count", async () => {
    const { deleteImage, registryClient } = store(() => "deleted");

    await reapWorkspaceImages({ db: {} as never, registryClient, retainedPlans: 1 });

    expect(deleteImage.mock.calls.map(([input]) => input.digest)).toEqual([
      "sha256:b1",
      "sha256:c1",
      "sha256:a1",
      "sha256:e1",
    ]);
  });

  it("counts in-use and missing outcomes, survives a store failure, and defers beyond the per-tick cap", async () => {
    const deleteImage = vi.fn(async (input: { digest: string }) => {
      if (input.digest === "sha256:b1") return "in-use" as const;
      if (input.digest === "sha256:c1") return "missing" as const;
      if (input.digest === "sha256:a1") throw new Error("daemon hiccup");
      return "deleted" as const;
    });
    const registryClient = { deleteImage } as unknown as RegistryClient;

    const summary = await reapWorkspaceImages({
      db: {} as never,
      registryClient,
      retainedPlans: 0,
      maxDeletesPerTick: 3,
    });

    expect(deleteImage).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      kept: 2,
      deleted: 0,
      inUse: 1,
      missing: 1,
      failed: 1,
      deferred: 1,
    });
  });
});
