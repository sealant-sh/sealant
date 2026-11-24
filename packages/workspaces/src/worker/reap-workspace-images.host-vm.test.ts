import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
  WorkspaceRuntimeInstanceRepo,
  type HostVmBaseImageReference,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { fakeService } from "@sealant/db/testing/fake-service";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { reapHostVmBaseImagesEffect } from "./reap-workspace-images.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const key = (n: number) => digest(n).replace(":", "-");

interface Host {
  readonly imagesDir: string;
  readonly dataDir: string;
  /** Base image labels of the runner containers Docker has, running or stopped. */
  containers: string[];
  rows: HostVmBaseImageReference[];
  dockerFails: boolean;
}

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

const host = async (): Promise<Host> => {
  root = await mkdtemp(joinPath(tmpdir(), "sealant-host-vm-gc-"));
  const imagesDir = joinPath(root, "images");
  const dataDir = joinPath(root, "data");
  await mkdir(imagesDir);
  await mkdir(dataDir);
  return { imagesDir, dataDir, containers: [], rows: [], dockerFails: false };
};

/** A base disk and its config, built `ageMs` ago. */
const baseDisk = async (h: Host, n: number, ageMs = 2 * HOUR) => {
  for (const name of [`${key(n)}.img`, `${key(n)}.config.json`]) {
    const path = joinPath(h.imagesDir, name);
    await writeFile(path, "x");
    await utimes(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  }
};

const dataDisk = async (h: Host, container: string, marker?: string) => {
  await mkdir(joinPath(h.dataDir, container), { recursive: true });
  await writeFile(joinPath(h.dataDir, container, "data.img"), "work");
  if (marker !== undefined) {
    await writeFile(joinPath(h.dataDir, container, "base-image-digest"), `${marker}\n`);
  }
  return joinPath(h.dataDir, container, "data.img");
};

const sweep = (h: Host) =>
  Effect.runPromise(
    reapHostVmBaseImagesEffect({
      imagesDir: h.imagesDir,
      dataDir: h.dataDir,
      now: NOW,
      commandRunner: async (_command, args) => {
        if (h.dockerFails) throw new Error("Cannot connect to the Docker daemon");
        expect(args.slice(0, 4)).toEqual([
          "ps",
          "-a",
          "--filter",
          "label=sealant.host-vm.base-image",
        ]);
        return { stdout: h.containers.join("\n"), stderr: "" };
      },
    }).pipe(
      Effect.provide(
        Layer.succeed(
          WorkspaceRuntimeInstanceRepo,
          fakeService<WorkspaceRuntimeInstanceRepoService>({
            listHostVmBaseImages: () => Effect.succeed(h.rows),
          }),
        ),
      ),
    ),
  );

const remaining = async (h: Host) => (await readdir(h.imagesDir)).toSorted();

describe("host VM base disk retention", () => {
  it("keeps the base disk of a retained executor whose stopped container was pruned", async () => {
    const h = await host();
    await baseDisk(h, 1);
    await baseDisk(h, 2);
    // Its container is gone (`docker container prune`), its row says it was never removed.
    h.rows = [
      {
        runId: "run_retained",
        dataDiskPath: await dataDisk(h, "sealant-vm-run_retained"),
        baseImageDigest: digest(1),
        removed: false,
      },
    ];
    const summary = await sweep(h);
    expect(await remaining(h)).toEqual([`${key(1)}.config.json`, `${key(1)}.img`]);
    expect(summary).toEqual({ kept: 1, deleted: 1, failed: 0 });
  });

  it("keeps a disk while a removed executor's data disk is still there", async () => {
    const h = await host();
    await baseDisk(h, 1);
    const dataDiskPath = await dataDisk(h, "sealant-vm-run_a");
    h.rows = [{ runId: "run_a", dataDiskPath, baseImageDigest: digest(1), removed: true }];
    await sweep(h);
    expect(await remaining(h)).toHaveLength(2);
    // Once that disk is gone too, nothing needs the base disk.
    await rm(dataDiskPath);
    await sweep(h);
    expect(await remaining(h)).toEqual([]);
  });

  it("keeps what a container, a data disk's marker or a recent build names", async () => {
    const h = await host();
    await baseDisk(h, 1);
    await baseDisk(h, 2);
    await baseDisk(h, 3, HOUR / 2);
    await baseDisk(h, 4);
    h.containers = [digest(1)];
    await dataDisk(h, "sealant-vm-orphan", digest(2));
    expect(await sweep(h)).toEqual({ kept: 3, deleted: 1, failed: 0 });
    expect(await remaining(h)).not.toContain(`${key(4)}.img`);
  });

  it("deletes nothing when Docker cannot say which containers it has", async () => {
    const h = await host();
    await baseDisk(h, 1);
    h.dockerFails = true;
    await expect(sweep(h)).rejects.toThrow(/Docker daemon/);
    expect(await remaining(h)).toHaveLength(2);
  });
});

describe("host VM base disk retention · its data directory", () => {
  it("deletes nothing when the data directory itself is gone", async () => {
    const h = await host();
    await baseDisk(h, 1);
    await rm(h.dataDir, { recursive: true });
    await expect(sweep(h)).rejects.toThrow(/ENOENT/);
    expect(await remaining(h)).toHaveLength(2);
  });

  it("passes over a stray file beside the runners' directories", async () => {
    const h = await host();
    await baseDisk(h, 1);
    await writeFile(joinPath(h.dataDir, "README"), "not a runner");
    await dataDisk(h, "sealant-vm-a", digest(1));
    expect(await sweep(h)).toEqual({ kept: 1, deleted: 0, failed: 0 });
  });
});
