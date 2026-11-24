/**
 * The host VM disks, built for real on this machine's Docker: a workspace image becomes a
 * read-only ext4 base disk whose files keep their owners and setuid bits, and a runner's data disk
 * is made once, sparse and owned by the runner's uid. Read back with `debugfs` in the tools image.
 * A control scope the caller made, with its sockets bound, keeps them through the runner's
 * preparation and a failed launch's cleanup.
 *
 * Run with: `pnpm --filter @sealant/workspaces test:e2e src/images/host-vm-disk.e2e.ts`.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
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

/** What a Unix socket answers to one connection. */
const answers = (path: string) =>
  new Promise<string>((done, fail) => {
    const socket = createConnection(path);
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString("utf8")));
    socket.once("end", () => done(text));
    socket.once("error", fail);
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

  it("converts an image whose file names and link targets are non-ASCII UTF-8", async () => {
    // What `ca-certificates` installs on every managed Ubuntu image: musl's libarchive could not
    // read this symlink ("Linkpath can't be converted from UTF-8 to current locale").
    const certificate =
      "/usr/share/ca-certificates/mozilla/NetLock_Arany_=Class_Gold=_Főtanúsítvány.crt";
    const pem = "/etc/ssl/certs/NetLock_Arany_=Class_Gold=_Főtanúsítvány.pem";
    // Short enough to be stored in the inode, where `debugfs` prints it.
    const shortLink = "/etc/ssl/certs/Főtanúsítvány.pem";
    const shortTarget = "NetLock_Arany_=Class_Gold=_Főtanúsítvány.pem";
    const tag = "sealant-host-vm-e2e-utf8:latest";
    await run("docker", ["build", "-q", "-t", tag, "-"], {
      input: [
        `FROM ${IMAGE}`,
        `RUN mkdir -p /usr/share/ca-certificates/mozilla /etc/ssl/certs \\`,
        ` && printf 'certificate' > '${certificate}' \\`,
        ` && ln -s '${certificate}' '${pem}' \\`,
        ` && ln -s '${shortTarget}' '${shortLink}'`,
        "",
      ].join("\n"),
    });
    try {
      const utf8Digest = (
        await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag])
      ).stdout.trim();
      const base = await storage.ensureBaseImage({ digest: utf8Digest, reference: tag });
      const debugfsStat = (path: string) =>
        inspectDisk(base.imagePath, "debugfs", "-R", `stat ${path}`, "/disk.img");
      // The file kept its name: found by it, with its content.
      expect(
        await inspectDisk(base.imagePath, "debugfs", "-R", `cat ${certificate}`, "/disk.img"),
      ).toBe("certificate");
      const long = await debugfsStat(pem);
      expect(long).toMatch(/Type: symlink/);
      // The whole target, byte for byte (it lives in a block, so only its length is printed).
      expect(long).toMatch(new RegExp(`Size: ${String(Buffer.byteLength(certificate))}\\b`));
      expect(await debugfsStat(shortLink)).toContain(`Fast link dest: "${shortTarget}"`);
    } finally {
      await run("docker", ["image", "rm", "-f", tag]).catch(() => undefined);
    }
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

  describe("a control scope the caller made first (SLNT-1332)", () => {
    const servers: Server[] = [];
    afterAll(async () => {
      await Promise.all(
        servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
      );
    });
    const listen = (path: string) =>
      new Promise<void>((done, fail) => {
        const server = createServer((socket) => socket.end("served\n"));
        servers.push(server);
        server.once("error", fail);
        server.listen(path, () => done());
      });

    it("keeps the caller's bound sockets through preparation and a failed launch's cleanup", async () => {
      const scope = joinPath(root, "control", "mend-e2e-scope");
      await mkdir(scope, { recursive: true });
      await listen(joinPath(scope, "capture.sock"));
      await listen(joinPath(scope, "session.sock"));

      await storage.prepareExecutor({
        containerName: "sealant-vm-e2e-scope",
        baseImageDigest: digest,
        controlScope: "mend-e2e-scope",
      });
      // The runner's (65532) and the control group's, and nobody else's. (The setgid bit survives
      // only where the control group is root's, as in Mend's volume: the tools container has no
      // CAP_FSETID.)
      expect(((await stat(scope)).mode & 0o777).toString(8)).toBe("770");
      expect(await storage.markedControlScope("sealant-vm-e2e-scope")).toBe("mend-e2e-scope");
      await writeFile(joinPath(scope, "boot-env.json"), "{}\n");

      await storage.removeExecutor("sealant-vm-e2e-scope", {
        controlScope: "mend-e2e-scope",
        keepCallerSockets: true,
      });
      expect((await readdir(scope)).toSorted()).toEqual(["capture.sock", "session.sock"]);
      expect((await lstat(joinPath(scope, "capture.sock"))).isSocket()).toBe(true);
      // Still the caller's: the same listeners answer.
      expect(await answers(joinPath(scope, "capture.sock"))).toBe("served\n");
      expect(await answers(joinPath(scope, "session.sock"))).toBe("served\n");
      expect(await storage.dataDiskExists("sealant-vm-e2e-scope")).toBe(false);

      // Removed for good, the scope goes with it.
      await storage.removeExecutor("sealant-vm-e2e-scope", { controlScope: "mend-e2e-scope" });
      await expect(stat(scope)).rejects.toThrow(/ENOENT/);
    }, 120_000);

    it("refuses a scope that is a link rather than follow it", async () => {
      const elsewhere = joinPath(root, "control", "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, joinPath(root, "control", "mend-e2e-link"));
      await expect(
        storage.prepareExecutor({
          containerName: "sealant-vm-e2e-link",
          baseImageDigest: digest,
          controlScope: "mend-e2e-link",
        }),
      ).rejects.toThrow(/is a link/);
    }, 120_000);
  });
});
