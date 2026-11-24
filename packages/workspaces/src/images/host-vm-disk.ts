/**
 * The disks a `host-vm` workspace boots from (agent-home `docs/workspace-isolation-architecture.md`
 * §5.2–§5.4), on the Docker host the worker drives:
 *
 *  - **Base disk** (`vda`): one read-only ext4 image per workspace image digest,
 *    `<images dir>/<key>.img`, with the image's OCI config saved beside it as
 *    `<key>.config.json` (`docker export` drops it; the guest applies its `Env`, `User`,
 *    `WorkingDir`, `Entrypoint` and `Cmd`). Built once per digest by streaming `docker export` of a
 *    stopped container straight into `mke2fs -d -` in a converter container that has no Docker
 *    socket, no network and no capabilities: the tar goes into the filesystem verbatim, so uid 0,
 *    setuid `04755` (`sudo`), file capabilities and device nodes survive, which unpacking into a
 *    host directory would lose. `tune2fs -O read-only` is a second step because e2fsprogs 1.47.4
 *    refuses `-O read-only` together with `^has_journal` in `mke2fs`.
 *  - **Data disk** (`vdb`): a sparse ext4 image per runner container,
 *    `<data dir>/<container>/data.img` (20 GiB logical cap by default), owned by `65532:65532`, the
 *    uid the runner drops to. Made once and never formatted again: it holds the workspace's work.
 *  - **Headroom**: launches are refused while the data directory's filesystem has less than
 *    10 GiB free, and below 3 GiB idle workspaces should be stopped (`HostVmHeadroom`).
 *
 * `<key>` is the digest with `:` replaced by `-` (`sha256-<hex>`): `sealant-vm-runner` takes it as
 * `--image-digest` and names both files by it, and a colon-free name survives every Docker mount
 * syntax.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join as joinPath, posix } from "node:path";

import { z } from "zod";

import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The uid and gid `sealant-vm-runner` drops to; it owns the data disk and the control directory. */
export const HOST_VM_RUNNER_UID = 65532;

/** The default logical size of a data disk: sparse, so it takes only what the guest writes. */
export const DEFAULT_HOST_VM_DATA_DISK_BYTES = 20 * GiB;
/** Below this much free space on the data directory's filesystem, no new VM is launched. */
export const DEFAULT_HOST_VM_LAUNCH_FLOOR_BYTES = 10 * GiB;
/** Below this much free space, idle VMs should be stopped to protect what else shares the disk. */
export const DEFAULT_HOST_VM_IDLE_STOP_FLOOR_BYTES = 3 * GiB;

/**
 * The converter's tools: e2fsprogs 1.47.x with libarchive, which `mke2fs -d -` loads to read a
 * tar on its stdin. Built on the Docker host on first use, tagged by this recipe's hash, unless the
 * deployment names its own image (`HostVmStorageOptions.toolsImage`).
 */
const TOOLS_DOCKERFILE = [
  "FROM alpine:3.22",
  "RUN apk add --no-cache e2fsprogs e2fsprogs-extra libarchive",
  "",
].join("\n");

/** The tag the converter image is built under: the recipe's hash, so a changed recipe rebuilds. */
export const HOST_VM_TOOLS_IMAGE_TAG = `sealant-vm-disk-tools:${createHash("sha256")
  .update(TOOLS_DOCKERFILE)
  .digest("hex")
  .slice(0, 12)}`;

/** A digest a base disk is named by: `sha256:` and 64 lowercase hex digits. */
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** A runner container's name, as the adapter makes it (`buildContainerName`). */
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/** The file name stem of a digest's base disk and config: `sha256-<hex>`. Throws on a non-digest. */
export const hostVmBaseImageKey = (digest: string): string => {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `'${digest}' is not a sha256 image digest; a host VM base disk is named by one.`,
    );
  }
  return digest.replace(":", "-");
};

/** The digest a base disk file stem names, or undefined when the name is not one. */
export const hostVmDigestOfKey = (key: string): string | undefined => {
  const digest = key.replace(/^sha256-/, "sha256:");
  return DIGEST_PATTERN.test(digest) ? digest : undefined;
};

const assertContainerName = (name: string): string => {
  if (!CONTAINER_NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a host VM runner container name.`);
  }
  return name;
};

/**
 * A directory the worker and the containers it starts both reach. `path` is where this worker
 * reads and writes it. `mount` is how a container on the Docker host mounts it: absent, the host
 * has it at the same path (a worker on the host itself); `bind`, at another host path (a worker in
 * a container with the directory bind-mounted); `volume`, as a named volume whose root `path` is
 * (Mend's `mend-vm-images`, `mend-vm-data`, `mend-control`), mounted by `volume-subpath`.
 */
export interface HostVmDirectory {
  readonly path: string;
  readonly mount?:
    | { readonly kind: "bind"; readonly hostPath: string }
    | { readonly kind: "volume"; readonly volume: string };
}

/**
 * The `--mount` for `subpath` of `directory` (the whole directory when empty) at `target` in a
 * container. `--mount` and not `-v`: its fields are comma-separated, so no path's colon can be
 * read as a field separator.
 */
export const hostVmMountArgs = (
  directory: HostVmDirectory,
  subpath: string,
  target: string,
  readOnly: boolean,
): readonly string[] => {
  const mode = readOnly ? ",readonly" : "";
  const mount = directory.mount;
  if (mount?.kind === "volume") {
    const sub = subpath.length === 0 ? "" : `,volume-subpath=${subpath}`;
    return ["--mount", `type=volume,source=${mount.volume}${sub},target=${target}${mode}`];
  }
  const root = mount?.kind === "bind" ? mount.hostPath : directory.path;
  const source = subpath.length === 0 ? root : posix.join(root, subpath);
  return ["--mount", `type=bind,source=${source},target=${target}${mode}`];
};

/** `docker <from> | docker <to>`, the first's stdout streamed into the second's stdin. */
export type DockerPipeRunner = (
  from: readonly string[],
  to: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const STDERR_LIMIT = 64 * 1024;

/** The live pipe: both `docker` processes against `dockerSocketPath`; fails if either fails. */
export const createDockerPipeRunner =
  (dockerSocketPath: string): DockerPipeRunner =>
  async (from, to, options) => {
    const env = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };
    const producer = spawn("docker", [...from], { env, stdio: ["ignore", "pipe", "pipe"] });
    const consumer = spawn("docker", [...to], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const collect = (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
    };
    producer.stderr.on("data", collect);
    consumer.stderr.on("data", collect);
    consumer.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STDERR_LIMIT) stdout += chunk.toString("utf8");
    });
    // The consumer exiting early closes its stdin: the producer's EPIPE is the consumer's
    // failure, reported by its exit code below.
    consumer.stdin.on("error", () => undefined);
    producer.stdout.pipe(consumer.stdin);
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            producer.kill("SIGKILL");
            consumer.kill("SIGKILL");
          }, options.timeoutMs);
    const exit = (child: ReturnType<typeof spawn>) =>
      new Promise<number | null>((done) => {
        child.once("error", (error) => {
          collect(Buffer.from(`${error.message}\n`));
          done(-1);
        });
        child.once("close", (code) => done(code));
      });
    const [fromCode, toCode] = await Promise.all([exit(producer), exit(consumer)]);
    if (timer !== undefined) clearTimeout(timer);
    if (fromCode !== 0 || toCode !== 0) {
      throw Object.assign(
        new Error(
          `docker ${from[0] ?? ""} | docker ${to[0] ?? ""} failed (exit ${String(fromCode)} | ${String(toCode)}): ${stderr.trim()}`,
        ),
        { stderr },
      );
    }
    return { stdout, stderr };
  };

/** What `docker image inspect` says of a workspace image, the fields the guest applies. */
const inspectedImageSchema = z.object({
  Size: z.number().int().nonnegative(),
  Config: z
    .object({
      Env: z.array(z.string()).nullish(),
      User: z.string().nullish(),
      WorkingDir: z.string().nullish(),
      Entrypoint: z.array(z.string()).nullish(),
      Cmd: z.array(z.string()).nullish(),
      Labels: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
});

/**
 * The saved image config, in the field names `sealant-vm-runner`'s `ImageConfig` reads
 * (`protocol.rs`). Absent fields are left out rather than written as null. `Labels` rides along
 * for the record; the runner ignores it.
 */
export interface HostVmImageConfig {
  readonly Env?: readonly string[];
  readonly User?: string;
  readonly WorkingDir?: string;
  readonly Entrypoint?: readonly string[];
  readonly Cmd?: readonly string[];
  readonly Labels?: Readonly<Record<string, string>>;
}

/** The image config of a `docker image inspect --format '{{json .}}'` answer, and its size. */
export const parseInspectedImage = (
  stdout: string,
): { readonly config: HostVmImageConfig; readonly sizeBytes: number } => {
  const parsed = inspectedImageSchema.parse(JSON.parse(stdout));
  const config = parsed.Config ?? {};
  return {
    sizeBytes: parsed.Size,
    config: {
      ...(config.Env == null ? {} : { Env: config.Env }),
      ...(config.User == null || config.User === "" ? {} : { User: config.User }),
      ...(config.WorkingDir == null || config.WorkingDir === ""
        ? {}
        : { WorkingDir: config.WorkingDir }),
      ...(config.Entrypoint == null ? {} : { Entrypoint: config.Entrypoint }),
      ...(config.Cmd == null ? {} : { Cmd: config.Cmd }),
      ...(config.Labels == null ? {} : { Labels: config.Labels }),
    },
  };
};

/**
 * The logical size `mke2fs` is given: twice the image's unpacked size plus 512 MiB, so the inode
 * table (one inode per 8 KiB) and the metadata of an image of many small files fit. The file is
 * sparse while it is built and `resize2fs -M` shrinks it to what the files take afterwards, so the
 * margin costs no disk.
 */
export const baseDiskBuildMiB = (imageSizeBytes: number): number =>
  Math.ceil((imageSizeBytes * 2 + 512 * MiB) / MiB);

/**
 * The converter's script. `$1` is the temporary image's path, `$2` its size in MiB. A failed fsck
 * (exit 2 or more) or resize fails the build: a base disk is never left half-made.
 */
const CONVERT_SCRIPT = [
  "set -eu",
  'mke2fs -q -t ext4 -O ^has_journal -m 0 -i 8192 -E root_owner=0:0 -L sealant-base -d - "$1" "$2M"',
  'code=0; e2fsck -fy "$1" >/dev/null 2>&1 || code=$?',
  'if [ "$code" -gt 1 ]; then echo "e2fsck found errors it could not repair ($code)" >&2; exit 1; fi',
  'resize2fs -M "$1" >/dev/null 2>&1',
  'tune2fs -O read-only "$1" >/dev/null',
  'chmod 0644 "$1"',
].join("\n");

/**
 * Make one runner container's directories. `$1` its name, `$2` the data disk's size in bytes, `$3`
 * the base image digest, `$4` the control directory's group. The data disk is formatted only when
 * there is none: an existing one holds the workspace's work.
 */
const PREPARE_SCRIPT = [
  "set -eu",
  'd="/data/$1"; c="/control/$1"',
  'mkdir -p "$d" "$c"',
  'if [ ! -e "$d/data.img" ]; then',
  '  truncate -s "$2" "$d/data.img.tmp"',
  '  mkfs.ext4 -q -F -E lazy_itable_init=1,lazy_journal_init=1 "$d/data.img.tmp"',
  `  chown ${String(HOST_VM_RUNNER_UID)}:${String(HOST_VM_RUNNER_UID)} "$d/data.img.tmp"`,
  '  chmod 0600 "$d/data.img.tmp"',
  '  printf "%s\\n" "$3" > "$d/base-image-digest"',
  '  mv "$d/data.img.tmp" "$d/data.img"',
  "fi",
  `chown ${String(HOST_VM_RUNNER_UID)}:${String(HOST_VM_RUNNER_UID)} "$d"`,
  'chmod 0755 "$d"',
  // The runner binds control.sock here as 65532; the setgid bit gives the socket the directory's
  // group, the one the worker shares, so the worker can connect.
  `chown ${String(HOST_VM_RUNNER_UID)}:"$4" "$c"`,
  'chmod 2770 "$c"',
].join("\n");

const REMOVE_SCRIPT = ["set -eu", 'rm -rf "/data/$1"'].join("\n");

/** What `HostVmStorage.headroom` measured on the data directory's filesystem. */
export interface HostVmHeadroom {
  readonly freeBytes: number;
  /** A new VM may be launched (at least the launch floor is free). */
  readonly admitsLaunch: boolean;
  /** Below the idle-stop floor: idle VMs should be stopped. */
  readonly low: boolean;
}

/** A base disk ready to mount: its digest, file stem and the two files, as the worker sees them. */
export interface HostVmBaseImage {
  readonly digest: string;
  readonly key: string;
  readonly imagePath: string;
  readonly configPath: string;
}

export interface HostVmStorageOptions {
  /** Base disks and their configs (`mend-vm-images`). */
  readonly imagesDir: HostVmDirectory;
  /** Per-container data disks (`mend-vm-data`). */
  readonly dataDir: HostVmDirectory;
  /** Per-container control directories (`mend-control`). */
  readonly controlDir: HostVmDirectory;
  readonly commandRunner: DockerCommandRunner;
  readonly pipeRunner: DockerPipeRunner;
  /** The converter image; built from `TOOLS_DOCKERFILE` on first use when absent. */
  readonly toolsImage?: string;
  /** A data disk's logical size. Defaults to 20 GiB. */
  readonly dataDiskBytes?: number;
  readonly launchFloorBytes?: number;
  readonly idleStopFloorBytes?: number;
  /** The group that shares control directories with the worker; defaults to the root's group. */
  readonly controlGroupId?: number;
  /** How long one conversion may take before it is killed. Defaults to 30 minutes. */
  readonly convertTimeoutMs?: number;
  /** Test seam: free bytes on the filesystem holding `path`. */
  readonly freeBytes?: (path: string) => Promise<number>;
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const liveFreeBytes = async (path: string): Promise<number> => {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
};

const temporaryName = (stem: string, suffix: string): string =>
  `.tmp-${stem}-${randomBytes(6).toString("hex")}${suffix}`;

/**
 * The host-side disks of `host-vm` workspaces. One per worker process: it serializes conversions
 * of the same digest in process (two launches of one image wait for one build), and every file it
 * publishes appears by an atomic rename, so a concurrent reader never sees half a file.
 */
export class HostVmStorage {
  readonly #options: HostVmStorageOptions;
  readonly #conversions = new Map<string, Promise<HostVmBaseImage>>();
  #toolsImage: Promise<string> | undefined;

  public constructor(options: HostVmStorageOptions) {
    this.#options = options;
  }

  public get imagesDir(): HostVmDirectory {
    return this.#options.imagesDir;
  }

  public get dataDir(): HostVmDirectory {
    return this.#options.dataDir;
  }

  public get controlDir(): HostVmDirectory {
    return this.#options.controlDir;
  }

  /** The base disk's paths for a digest, whether or not it was built. */
  public baseImage(digest: string): HostVmBaseImage {
    const key = hostVmBaseImageKey(digest);
    return {
      digest,
      key,
      imagePath: joinPath(this.#options.imagesDir.path, `${key}.img`),
      configPath: joinPath(this.#options.imagesDir.path, `${key}.config.json`),
    };
  }

  /** Where a runner container's data disk is, as the worker sees it. */
  public dataDiskPath(containerName: string): string {
    return joinPath(this.#options.dataDir.path, assertContainerName(containerName), "data.img");
  }

  /** Where a runner container's control directory is, as the worker sees it. */
  public controlPath(containerName: string): string {
    return joinPath(this.#options.controlDir.path, assertContainerName(containerName));
  }

  /**
   * The base image digest a data disk was made for, from the marker written beside it, or
   * undefined when there is none (or it names no digest).
   */
  public async markedBaseImageDigest(containerName: string): Promise<string | undefined> {
    const marker = joinPath(
      this.#options.dataDir.path,
      assertContainerName(containerName),
      "base-image-digest",
    );
    try {
      const digest = (await readFile(marker, "utf8")).trim();
      return DIGEST_PATTERN.test(digest) ? digest : undefined;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async dataDiskExists(containerName: string): Promise<boolean> {
    return fileExists(this.dataDiskPath(containerName));
  }

  /**
   * The base disk for `digest`, built from `reference` (an image reference that resolves to that
   * digest) when this host has none yet. Concurrent calls for one digest share one build.
   */
  public ensureBaseImage(image: {
    readonly digest: string;
    readonly reference: string;
  }): Promise<HostVmBaseImage> {
    const target = this.baseImage(image.digest);
    const running = this.#conversions.get(target.key);
    if (running !== undefined) return running;
    const conversion = this.#convertOnce(target, image.reference).finally(() => {
      this.#conversions.delete(target.key);
    });
    this.#conversions.set(target.key, conversion);
    return conversion;
  }

  async #convertOnce(target: HostVmBaseImage, reference: string): Promise<HostVmBaseImage> {
    if ((await fileExists(target.imagePath)) && (await fileExists(target.configPath))) {
      return target;
    }
    await mkdir(this.#options.imagesDir.path, { recursive: true });
    const run = this.#options.commandRunner;
    const inspected = parseInspectedImage(await this.#inspectOrPull(reference));

    // The config first, the disk last: the disk's appearance is what says the pair is complete.
    const configTemp = joinPath(this.#options.imagesDir.path, temporaryName(target.key, ".json"));
    try {
      await writeFile(configTemp, `${JSON.stringify(inspected.config)}\n`, { mode: 0o644 });
      await rename(configTemp, target.configPath);
    } finally {
      await rm(configTemp, { force: true });
    }

    const toolsImage = await this.#ensureToolsImage();
    // The converter runs as the images directory's owner, so it can write there with no
    // capability at all.
    const owner = await stat(this.#options.imagesDir.path);
    const imageTemp = temporaryName(target.key, ".img");
    const created = await run("docker", [
      "create",
      "--entrypoint",
      "/sealant-export-only",
      "--label",
      "sealant.host-vm.export=1",
      reference,
    ]);
    const containerId = created.stdout.trim();
    try {
      await this.#options.pipeRunner(
        ["export", containerId],
        [
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--user",
          `${String(owner.uid)}:${String(owner.gid)}`,
          ...hostVmMountArgs(this.#options.imagesDir, "", "/out", false),
          "--entrypoint",
          "sh",
          toolsImage,
          "-c",
          CONVERT_SCRIPT,
          "sealant-convert",
          `/out/${imageTemp}`,
          String(baseDiskBuildMiB(inspected.sizeBytes)),
        ],
        { timeoutMs: this.#options.convertTimeoutMs ?? 30 * 60_000 },
      );
      await rename(joinPath(this.#options.imagesDir.path, imageTemp), target.imagePath);
    } finally {
      await rm(joinPath(this.#options.imagesDir.path, imageTemp), { force: true }).catch(
        () => undefined,
      );
      await run("docker", ["rm", "-f", containerId]).catch(() => undefined);
    }
    return target;
  }

  async #inspectOrPull(reference: string): Promise<string> {
    const run = this.#options.commandRunner;
    const inspect = () =>
      run("docker", ["image", "inspect", "--format", "{{json .}}", reference]).then(
        (result) => result.stdout,
      );
    try {
      return await inspect();
    } catch {
      await run("docker", ["pull", reference]);
      return inspect();
    }
  }

  #ensureToolsImage(): Promise<string> {
    if (this.#options.toolsImage !== undefined) return Promise.resolve(this.#options.toolsImage);
    this.#toolsImage ??= (async () => {
      const tag = HOST_VM_TOOLS_IMAGE_TAG;
      const run = this.#options.commandRunner;
      try {
        await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
      } catch {
        await run("docker", ["build", "-q", "-t", tag, "-"], { input: TOOLS_DOCKERFILE });
      }
      return tag;
    })().catch((error: unknown) => {
      this.#toolsImage = undefined;
      throw error;
    });
    return this.#toolsImage;
  }

  /**
   * Make a runner container's data disk (once; an existing one is kept as it is), the marker of
   * the base image it was made for, and its control directory. Returns the data disk's path.
   */
  public async prepareExecutor(input: {
    readonly containerName: string;
    readonly baseImageDigest: string;
  }): Promise<string> {
    const name = assertContainerName(input.containerName);
    hostVmBaseImageKey(input.baseImageDigest);
    await mkdir(this.#options.dataDir.path, { recursive: true });
    await mkdir(this.#options.controlDir.path, { recursive: true });
    const group = this.#options.controlGroupId ?? (await stat(this.#options.controlDir.path)).gid;
    await this.#runTools(PREPARE_SCRIPT, [
      name,
      String(this.#options.dataDiskBytes ?? DEFAULT_HOST_VM_DATA_DISK_BYTES),
      input.baseImageDigest,
      String(group),
    ]);
    return this.dataDiskPath(name);
  }

  /** Delete a runner container's data disk directory. Idempotent. */
  public async removeExecutorDisk(containerName: string): Promise<void> {
    await this.#runTools(REMOVE_SCRIPT, [assertContainerName(containerName)]);
  }

  async #runTools(script: string, args: readonly string[]): Promise<void> {
    const toolsImage = await this.#ensureToolsImage();
    await this.#options.commandRunner("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      // Making files for 65532 and a directory for the shared group: nothing else.
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "0:0",
      ...hostVmMountArgs(this.#options.dataDir, "", "/data", false),
      ...hostVmMountArgs(this.#options.controlDir, "", "/control", false),
      "--entrypoint",
      "sh",
      toolsImage,
      "-c",
      script,
      "sealant-host-vm",
      ...args,
    ]);
  }

  /** Free space on the data directory's filesystem, against the launch and idle-stop floors. */
  public async headroom(): Promise<HostVmHeadroom> {
    const freeBytes = await (this.#options.freeBytes ?? liveFreeBytes)(this.#options.dataDir.path);
    return {
      freeBytes,
      admitsLaunch:
        freeBytes >= (this.#options.launchFloorBytes ?? DEFAULT_HOST_VM_LAUNCH_FLOOR_BYTES),
      low: freeBytes < (this.#options.idleStopFloorBytes ?? DEFAULT_HOST_VM_IDLE_STOP_FLOOR_BYTES),
    };
  }

  /** Throws, with the remedy, when a new VM would take the data filesystem below its floor. */
  public async assertLaunchHeadroom(): Promise<void> {
    const headroom = await this.headroom();
    if (headroom.admitsLaunch) return;
    const floor = this.#options.launchFloorBytes ?? DEFAULT_HOST_VM_LAUNCH_FLOOR_BYTES;
    throw Object.assign(
      new Error(
        `Only ${formatGiB(headroom.freeBytes)} is free where host VM data disks live (${this.#options.dataDir.path}); a new host VM needs at least ${formatGiB(floor)}. Free space there, stop idle workspaces, or move the VM data directory to its own filesystem.`,
      ),
      { code: "adapter-unavailable" },
    );
  }
}

const formatGiB = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`;
