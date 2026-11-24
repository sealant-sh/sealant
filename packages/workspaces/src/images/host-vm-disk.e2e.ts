/**
 * The host VM disks, built for real on this machine's Docker: a workspace image becomes a
 * read-only ext4 base disk whose files keep their owners and setuid bits, and a runner's data disk
 * is made once, sparse and owned by the runner's uid. Read back with `debugfs` in the tools image.
 *
 * Run with: `pnpm --filter @sealant/workspaces test:e2e src/images/host-vm-disk.e2e.ts`.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import { createDockerPipeRunner, HOST_VM_TOOLS_IMAGE_TAG, HostVmStorage } from "./host-vm-disk.js";

const SOCKET = process.env["DOCKER_SOCKET_PATH"] ?? "/var/run/docker.sock";
/** An image with a setuid binary (`/usr/bin/passwd`, 04755) owned by root. */
const IMAGE = "ubuntu:24.04";

const run = createDockerCommandRunner(SOCKET);
let root = "";
let storage: HostVmStorage;
let digest = "";
let reference = "";

beforeAll(async () => {
  root = await mkdtemp(joinPath(tmpdir(), "sealant-host-vm-e2e-"));
  storage = new HostVmStorage({
    imagesDir: { path: joinPath(root, "images") },
    dataDir: { path: joinPath(root, "data") },
    controlDir: { path: joinPath(root, "control") },
    commandRunner: run,
    pipeRunner: createDockerPipeRunner(SOCKET),
    dataDiskBytes: 256 * 1024 * 1024,
  });
  await run("docker", ["pull", "-q", IMAGE]);
  // Any digest names the base disk; the image's own id is one this host always has.
  digest = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE])).stdout.trim();
  reference = IMAGE;
}, 300_000);

afterAll(async () => {
  // The tools container made the data and control directories as root.
  await run("docker", [
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${root},target=/work`,
    "alpine:3.22",
    "rm",
    "-rf",
    "/work/data",
    "/work/control",
  ]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/** A read-only look at a disk image with the converter's own tools. */
const inspectDisk = async (image: string, ...command: string[]): Promise<string> => {
  const [entrypoint = "", ...args] = command;
  const result = await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=bind,source=${image},target=/disk.img,readonly`,
    "--entrypoint",
    entrypoint,
    HOST_VM_TOOLS_IMAGE_TAG,
    ...args,
  ]);
  return result.stdout;
};

describe("host VM disks on a real Docker host", () => {
  it("converts an image into a read-only ext4 disk that keeps owners and setuid bits", async () => {
    const base = await storage.ensureBaseImage({ digest, reference });
    const passwd = await inspectDisk(
      base.imagePath,
      "debugfs",
      "-R",
      "stat /usr/bin/passwd",
      "/disk.img",
    );
    expect(passwd).toMatch(/Mode:\s+04755/);
    expect(passwd).toMatch(/User:\s+0\s+Group:\s+0/);
    const features = await inspectDisk(base.imagePath, "dumpe2fs", "-h", "/disk.img");
    expect(features).toMatch(/Filesystem features:.*read-only/);
    expect(features).not.toMatch(/has_journal/);
    const config = JSON.parse(await readFile(base.configPath, "utf8"));
    expect(config.Env.some((entry: string) => entry.startsWith("PATH="))).toBe(true);
  }, 300_000);

  it("makes a sparse data disk for the runner's uid, once", async () => {
    const { dataDiskPath: path, created } = await storage.prepareExecutor({
      containerName: "sealant-vm-e2e",
      baseImageDigest: digest,
    });
    // As a container sees it (a Docker with remapped uids shows the host another number).
    const seen = async () =>
      (
        await run("docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=bind,source=${path},target=/data.img,readonly`,
          "--entrypoint",
          "stat",
          HOST_VM_TOOLS_IMAGE_TAG,
          "-c",
          "%u:%g %s %b %B %Y",
          "/data.img",
        ])
      ).stdout.trim();
    const first = await seen();
    const [owner, size, blocks, blockSize] = first.split(" ");
    expect(owner).toBe("65532:65532");
    expect(Number(size)).toBe(256 * 1024 * 1024);
    // Sparse: it takes far less than its logical size.
    expect(Number(blocks) * Number(blockSize)).toBeLessThan(Number(size));
    expect(created).toBe(true);
    const again = await storage.prepareExecutor({
      containerName: "sealant-vm-e2e",
      baseImageDigest: digest,
    });
    expect(again.created).toBe(false);
    // Not formatted again: the same file, untouched.
    expect(await seen()).toBe(first);
    expect((await stat(path)).size).toBe(256 * 1024 * 1024);
    expect(await storage.markedBaseImageDigest("sealant-vm-e2e")).toBe(digest);
  }, 120_000);
});
