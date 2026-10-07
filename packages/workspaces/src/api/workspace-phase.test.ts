/**
 * The launch phase a workspace read reports while the workspace is not ready: queued, building
 * its image (with the build's progress), or booting on a built image.
 */
import type { WorkspaceBuildJob, WorkspaceRuntimeInstance } from "@sealant/db";
import { describe, expect, it } from "vitest";

import { resolveWorkspacePhase } from "./workspace.js";

const at = (iso: string) => new Date(iso);

const job = (overrides: Partial<WorkspaceBuildJob>): WorkspaceBuildJob =>
  ({
    id: "job_1",
    status: "queued",
    createdAt: at("2026-10-07T20:44:00.000Z"),
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
    ...overrides,
  }) as WorkspaceBuildJob;

describe("resolveWorkspacePhase", () => {
  it("is queued until a worker takes the launch", () => {
    expect(resolveWorkspacePhase({ status: "queued", latestJob: job({}) })).toEqual({
      name: "queued",
      since: "2026-10-07T20:44:00.000Z",
    });
  });

  it("reports the image build and its progress while the build job runs", () => {
    const phase = resolveWorkspacePhase({
      status: "running",
      latestJob: job({
        status: "running",
        claimedAt: at("2026-10-07T20:44:02.000Z"),
        progress: {
          step: 2,
          steps: 12,
          stepName: "RUN apt-get update",
          progressAt: "2026-10-07T20:49:00.000Z",
          stallTimeoutMs: 600_000,
        },
      }),
    });
    expect(phase).toEqual({
      name: "image-build",
      since: "2026-10-07T20:44:02.000Z",
      imageBuild: {
        step: 2,
        steps: 12,
        stepName: "RUN apt-get update",
        progressAt: "2026-10-07T20:49:00.000Z",
        stallTimeoutMs: 600_000,
      },
    });
  });

  it("reports an image build without progress from a builder that reports none", () => {
    expect(
      resolveWorkspacePhase({
        status: "running",
        latestJob: job({ status: "running", claimedAt: at("2026-10-07T20:44:02.000Z") }),
      }),
    ).toEqual({ name: "image-build", since: "2026-10-07T20:44:02.000Z" });
  });

  it("is booting once the image is built and the executor has not answered", () => {
    expect(
      resolveWorkspacePhase({
        status: "running",
        latestJob: job({ status: "succeeded", finishedAt: at("2026-10-07T20:53:13.000Z") }),
        runtimeInstance: {
          createdAt: at("2026-10-07T20:53:14.000Z"),
        } as WorkspaceRuntimeInstance,
      }),
    ).toEqual({ name: "boot", since: "2026-10-07T20:53:14.000Z" });
  });

  it("is absent once the workspace is ready or ended", () => {
    for (const status of ["ready", "failed", "stopped", "cancelled", "retained"] as const) {
      expect(
        resolveWorkspacePhase({ status, latestJob: job({ status: "succeeded" }) }),
      ).toBeUndefined();
    }
  });
});
