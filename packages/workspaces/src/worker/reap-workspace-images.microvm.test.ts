/**
 * Image retention for Lambda MicroVM images: the same keep rules as every other image, deleted with
 * `DeleteMicrovmImage` instead of through a registry, plus the builder's images no build job names.
 */
import type { DB, PublishedWorkspaceImage, WorkspaceBuildJob } from "@sealant/db";
import { fakeService } from "@sealant/db/testing/fake-service";
import { describe, expect, it, vi } from "vitest";

import type { MicrovmImageDescription } from "../images/microvm/image-api.js";
import { microvmImageName } from "../images/microvm/recipe.js";
import type { RegistryClient } from "../registry/client.js";
import { reapWorkspaceImages } from "./reap-workspace-images.js";

const hoursAgo = (hours: number): Date => new Date(Date.UTC(2026, 8, 20, 12 - hours));
const arn = (name: string): string =>
  `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}`;

/** A plan hash from a letter: 64 hex, so its image name is the real `sealant-ws-<24 hex>`. */
const plan = (letter: string): string => letter.repeat(64);
const nameOf = (letter: string): string => microvmImageName(plan(letter));

const microvm = (
  letter: string,
  overrides: { readonly runId?: string; readonly publishedAt?: Date } = {},
): PublishedWorkspaceImage => ({
  jobId: `job-${letter}`,
  runId: overrides.runId ?? null,
  registryId: "default",
  publication: {
    kind: "microvm",
    publicationId: `job-${letter}`,
    image: { imageArn: arn(nameOf(letter)), imageVersion: "1.0", planHash: plan(letter) },
    evidence: { planHash: plan(letter) },
  },
  publishedAt: overrides.publishedAt ?? hoursAgo(1),
});

// Newest first, as the repository returns them.
const published: PublishedWorkspaceImage[] = [
  // a: a workspace is on it. b: the second retained plan. c: unused.
  microvm("a", { runId: "run-live", publishedAt: hoursAgo(1) }),
  microvm("b", { publishedAt: hoursAgo(2) }),
  microvm("c", { publishedAt: hoursAgo(3) }),
  {
    jobId: "job-d",
    runId: null,
    registryId: "default",
    publishedAt: hoursAgo(4),
    publication: {
      kind: "oci",
      publicationId: "job-d",
      evidence: { planHash: plan("d") },
      image: {
        repository: "sealant-workspace-arch",
        tag: "plan-000000000000",
        reference: "sealant-workspace-arch:plan-000000000000",
        digestReference: `sealant-workspace-arch@sha256:${plan("d")}`,
        digest: `sha256:${plan("d")}`,
      },
    },
  },
];

vi.mock("@sealant/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sealant/db")>();
  const { Effect, Layer } = await import("effect");
  // The factory runs hoisted above this file's imports, so it imports what it uses itself.
  const { fakeService: fake } = await import("@sealant/db/testing/fake-service");
  const { buildJobRow, workspaceRow } = await import("@sealant/db/testing/rows");
  const jobByRun = new Map<string, WorkspaceBuildJob>([
    ["run-live", buildJobRow({ runId: "run-live", publishedDigest: `sha256:${"a".repeat(64)}` })],
  ]);
  return {
    ...actual,
    WorkspaceRepoLive: Layer.succeed(
      actual.WorkspaceRepo,
      fake({
        listWorkspaces: () =>
          Effect.succeed([
            workspaceRow({ id: "ws-live", status: "ready", latestRunId: "run-live" }),
          ]),
      }),
    ),
    WorkspaceRuntimeInstanceRepoLive: Layer.succeed(
      actual.WorkspaceRuntimeInstanceRepo,
      fake({
        listRunningInstances: () => Effect.succeed([]),
      }),
    ),
    WorkspaceBuildJobRepoLive: Layer.succeed(
      actual.WorkspaceBuildJobRepo,
      fake({
        listPublishedImages: () => Effect.succeed(published),
        listLatestJobsByRunIds: (runIds: readonly string[]) =>
          Effect.succeed(
            new Map(
              runIds.flatMap((id) => {
                const job = jobByRun.get(id);
                return job === undefined ? [] : [[id, job] as const];
              }),
            ),
          ),
      }),
    ),
  };
});

/** As the platform lists an image: no tags. */
const listed = (
  name: string,
  overrides: Partial<MicrovmImageDescription> = {},
): MicrovmImageDescription => ({
  imageArn: arn(name),
  name,
  state: "CREATED",
  latestActiveImageVersion: "1.0",
  createdAt: hoursAgo(48),
  ...overrides,
});

const account = (images: readonly MicrovmImageDescription[]) => {
  const deleted: string[] = [];
  return {
    deleted,
    microvmImages: {
      namePrefix: "sealant-ws",
      api: {
        listImages: async (nameContains: string) =>
          images.filter((image) => image.name.includes(nameContains)),
        deleteImage: async (name: string) => {
          deleted.push(name);
          return name === nameOf("9") ? ("not-found" as const) : ("deleted" as const);
        },
      },
    },
  };
};

const registry = () => {
  const deleteImage = vi.fn(
    async (_input: { repository: string; digest: string }) => "deleted" as const,
  );
  return { deleteImage, registryClient: fakeService<RegistryClient>({ deleteImage }) };
};

describe("reapWorkspaceImages, MicroVM images", () => {
  const now = hoursAgo(0).getTime();

  it("deletes an unused MicroVM image with DeleteMicrovmImage, never through the registry", async () => {
    const aws = account([]);
    const { deleteImage, registryClient } = registry();

    const summary = await reapWorkspaceImages({
      db: fakeService<DB>({}),
      registryClient,
      microvmImages: aws.microvmImages,
      retainedPlans: 2,
      now,
      minAgeMs: 0,
    });

    expect(aws.deleted).toEqual([nameOf("c")]);
    expect(deleteImage.mock.calls.map(([input]) => input)).toEqual([
      { repository: "sealant-workspace-arch", digest: `sha256:${plan("d")}` },
    ]);
    expect(summary).toMatchObject({ kept: 2, deleted: 2 });
  });

  it("keeps every version of an image when one version is retained", async () => {
    const existing = microvm("a");
    if (existing.publication.kind !== "microvm") throw new Error("MicroVM fixture required.");
    published.push({
      ...existing,
      jobId: "job-a-old-version",
      runId: null,
      publishedAt: hoursAgo(100),
      publication: {
        ...existing.publication,
        publicationId: "job-a-old-version",
        image: { ...existing.publication.image, imageVersion: "0.9" },
      },
    });
    const aws = account([]);
    try {
      await reapWorkspaceImages({
        db: fakeService<DB>({}),
        registryClient: registry().registryClient,
        microvmImages: aws.microvmImages,
        retainedPlans: 0,
        minAgeMs: 0,
        now,
      });
      expect(aws.deleted).toEqual([nameOf("b"), nameOf("c")]);
    } finally {
      published.pop();
    }
  });

  it("leaves MicroVM images alone on a worker that does not build them", async () => {
    const { deleteImage, registryClient } = registry();

    await reapWorkspaceImages({
      db: fakeService<DB>({}),
      registryClient,
      retainedPlans: 2,
      now,
      minAgeMs: 0,
    });

    expect(deleteImage.mock.calls.map(([input]) => input)).toEqual([
      { repository: "sealant-workspace-arch", digest: `sha256:${plan("d")}` },
    ]);
  });

  it("sweeps its own images that no build job names, told by name, and nothing else in the account", async () => {
    const aws = account([
      listed(nameOf("8")),
      listed(nameOf("9")),
      // A workspace is on this plan, and the job history names it.
      listed(nameOf("a")),
      // Not old enough to be sure nothing is about to use it.
      listed(nameOf("7"), { createdAt: hoursAgo(1) }),
      // A build in flight.
      listed(nameOf("6"), { state: "CREATING" }),
      // Another control plane's, under its own prefix, and an image somebody made by hand.
      listed(microvmImageName(plan("8"), "staging-ws")),
      listed("sealant-ws-by-hand"),
      listed("someone-elses"),
    ]);

    const summary = await reapWorkspaceImages({
      db: fakeService<DB>({}),
      registryClient: registry().registryClient,
      microvmImages: aws.microvmImages,
      retainedPlans: 10,
      now,
      minAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(aws.deleted).toEqual([nameOf("8"), nameOf("9")]);
    expect(summary).toMatchObject({ deleted: 1, missing: 1, failed: 0 });
  });

  it("survives an account that cannot be listed or an image that cannot be deleted", async () => {
    const summary = await reapWorkspaceImages({
      db: fakeService<DB>({}),
      registryClient: registry().registryClient,
      microvmImages: {
        namePrefix: "sealant-ws",
        api: {
          listImages: async () => {
            throw new Error("AccessDenied");
          },
          deleteImage: async () => {
            throw new Error("ResourceConflict");
          },
        },
      },
      retainedPlans: 2,
      now,
      minAgeMs: 0,
    });

    expect(summary).toMatchObject({ deleted: 1, failed: 1 });
  });
});
