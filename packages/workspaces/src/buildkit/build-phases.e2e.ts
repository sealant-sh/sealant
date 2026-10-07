/**
 * The image-build phase against a real Docker Engine:
 *
 * - **Progress.** A real `docker build` of a workspace image reports its steps (`[N/M]`) as it
 *   runs, which is what the worker writes to the job row and the API reports as the launch's
 *   `image-build` phase.
 * - **A kept image is reused.** With no publish on record (a fresh database), the Docker builder
 *   finds the plan's image the Engine kept under its plan coordinates, reads its probe back from
 *   it, and answers with it: nothing is built.
 * - **A silent build is stopped.** A `docker build` that writes nothing for the idle bound is
 *   stopped and fails as idle (the compiler turns that into `image-build-stalled`).
 *
 * Needs Docker and the network for the image's packages (warm when the baked image was just built:
 * same blueprint as `scripts/sealantd-build-image.mts`). Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/buildkit/build-phases.e2e.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkspaceBlueprint } from "@sealant/validators";
import { afterAll, describe, expect, it } from "vitest";

import { createDockerWorkspaceImageBuilder } from "../images/image-builder.js";
import { planImageCoordinates } from "../images/plan-coordinates.js";
import { LocalDockerImageStore } from "../registry/local-docker.js";
import type { ImageBuildProgress } from "./build-progress.js";
import {
  COMMAND_IDLE_TIMEOUT_CODE,
  compileWorkspaceBuildSpec,
  planWorkspaceImageBuild,
  removeBuildContext,
  runBuildkitCommand,
} from "./buildkit-builder.js";

const blueprint = parseWorkspaceBlueprint({
  sources: {
    workspace: {
      url: "https://github.com/octocat/Hello-World.git",
      ref: "master",
    },
  },
  harness: { id: "claude-code" },
  target: { os: { family: "fedora" } },
  customization: { enableSealantd: true },
});

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.toReversed()) await step().catch(() => undefined);
});

describe("the image-build phase on a real Docker Engine", () => {
  it("reports the build's steps, then reuses the kept image without a build", async () => {
    const seen: ImageBuildProgress[] = [];
    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: {
        emitTarball: false,
        stallTimeoutMs: 10 * 60_000,
        onProgress: (progress) => seen.push(progress),
      },
    });
    cleanup.push(() => removeBuildContext(result.buildkit.spec.contextDirectory));

    const stepped = seen.filter((progress) => progress.step !== undefined);
    expect(stepped.length).toBeGreaterThan(0);
    const last = stepped.at(-1);
    expect(last?.steps).toBeGreaterThan(1);
    expect(last?.step).toBe(last?.steps);
    expect(last?.stallTimeoutMs).toBe(10 * 60_000);

    // The worker publishes the build under its plan coordinates in the Engine.
    const planned = planWorkspaceImageBuild({ blueprint });
    expect(result.metadata?.planHash).toBe(planned.planHash);
    const store = new LocalDockerImageStore();
    const coordinates = planImageCoordinates(planned);
    const published = await store.publishOciImage({
      ...coordinates,
      sourceReference: result.buildkit.spec.imageReference,
    });

    // A fresh database has no record of that publish; the Engine still has the image.
    const builder = createDockerWorkspaceImageBuilder({
      registryClient: store,
    });
    const startedAt = Date.now();
    const found = await builder.findPublished?.({ planned, ...coordinates });
    const tookMs = Date.now() - startedAt;

    expect(found?.publishedImage.digest).toBe(published.digest);
    expect(found?.build.metadata?.imageProbe).toEqual(result.metadata?.imageProbe);
    expect(found?.build.metadata?.planHash).toBe(planned.planHash);
    // An inspect and one short `docker run` for the probe: seconds, not a build.
    expect(tookMs).toBeLessThan(15_000);
  }, 900_000);

  it("stops a docker build that writes nothing for the idle bound", async () => {
    const context = await mkdtemp(join(tmpdir(), "sealant-stall-e2e-"));
    cleanup.push(() => rm(context, { recursive: true, force: true }));
    const tag = `sealant-stall-e2e:${randomUUID().slice(0, 8)}`;
    cleanup.push(() => runBuildkitCommand("docker", ["image", "rm", "-f", tag]));
    // Built FROM the image the first test left (no pull); a unique RUN so nothing is cached.
    await writeFile(
      join(context, "Containerfile"),
      `FROM sealant-workspace-fedora:latest\nRUN echo ${randomUUID()} && sleep 60\n`,
    );

    const startedAt = Date.now();
    await expect(
      runBuildkitCommand(
        "docker",
        [
          "build",
          "--progress=plain",
          "--file",
          join(context, "Containerfile"),
          "--tag",
          tag,
          context,
        ],
        { idleTimeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ code: COMMAND_IDLE_TIMEOUT_CODE });
    expect(Date.now() - startedAt).toBeLessThan(40_000);
  }, 120_000);
});
