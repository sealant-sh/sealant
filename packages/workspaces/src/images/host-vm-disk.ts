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
import { mkdir, readFile, rename, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import { join as joinPath, posix } from "node:path";

import { z } from "zod";

import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The uid and gid `sealant-vm-runner` drops to; it owns the data disk and the control directory. */
export const HOST_VM_RUNNER_UID = 65532;
/** Sentinel file `mend server setup` writes in a macOS host bind-mounted VM data directory. */
export const HOST_VM_DATA_SENTINEL = ".mend-vm-data";

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
 *
 * Debian's glibc build, not Alpine's: musl's libarchive refuses a tar entry whose name or link
 * target is non-ASCII UTF-8 ("Linkpath can't be converted from UTF-8 to current locale") whatever
 * the locale, and every Ubuntu image with `ca-certificates` has one
 * (`/etc/ssl/certs/NetLock_Arany_=Class_Gold=_Főtanúsítvány.pem`). The UTF-8 locale keeps names
 * byte for byte.
 */
const TOOLS_DOCKERFILE = [
  "FROM debian:trixie-slim",
  "RUN apt-get update \\",
  " && apt-get install -y --no-install-recommends e2fsprogs libarchive13t64 \\",
  " && rm -rf /var/lib/apt/lists/*",
  "ENV LANG=C.UTF-8 LC_ALL=C.UTF-8",
  "",
].join("\n");

/** The tag the converter image is built under: the recipe's hash, so a changed recipe rebuilds. */
export const HOST_VM_TOOLS_IMAGE_TAG = `sealant-vm-disk-tools:${createHash("sha256")
  .update(TOOLS_DOCKERFILE)
  .digest("hex")
  .slice(0, 12)}`;

/** A digest a base disk is named by: `sha256:` and 64 lowercase hex digits. */
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/**
 * A runner container's name, as the adapter makes it (`buildContainerName`), and the shape of a
 * control scope (`CONTROL_SCOPE_PATTERN`): one path segment.
 */
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
    | {
        readonly kind: "volume";
        readonly volume: string;
        /** Where in the volume `path` is; absent, the volume's root. */
        readonly subpath?: string;
      };
}

/**
 * The `HostVmDirectory` of a worker path: on a worker whose mounts are named volumes
 * (`SEALANT_DOCKER_VOLUME_MAPPINGS`), the volume whose logical root holds it, at its subpath;
 * otherwise the same path on the host.
 */
export const hostVmDirectoryFor = (
  directory: string,
  mappings: ReadonlyArray<
    | { readonly logicalRoot: string; readonly volumeName: string }
    | { readonly logicalRoot: string; readonly hostPath: string }
  > = [],
): HostVmDirectory => {
  for (const mapping of mappings) {
    const exact = directory === mapping.logicalRoot;
    const nested = directory.startsWith(`${mapping.logicalRoot}/`);
    if (!exact && !nested) continue;
    const subpath = nested ? directory.slice(mapping.logicalRoot.length + 1) : undefined;
    if ("hostPath" in mapping) {
      return {
        path: directory,
        mount: {
          kind: "bind",
          hostPath:
            subpath === undefined ? mapping.hostPath : posix.join(mapping.hostPath, subpath),
        },
      };
    }
    return {
      path: directory,
      mount: {
        kind: "volume",
        volume: mapping.volumeName,
        ...(subpath === undefined ? {} : { subpath }),
      },
    };
  }
  return { path: directory };
};

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
    const full = [mount.subpath ?? "", subpath].filter((part) => part.length > 0).join("/");
    const sub = full.length === 0 ? "" : `,volume-subpath=${full}`;
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
 * the base image digest, `$4` the control directory's group, `$5` its control scope (the name,
 * unless the launch named one). The data disk is formatted only when there is none: an existing
 * one holds the workspace's work. The control scope may already exist, made by the caller with
 * its `capture.sock` and `session.sock` bound in it: nothing in it is removed, and a link is
 * refused rather than followed.
 */
const PREPARE_SCRIPT = [
  "set -eu",
  'd="/data/$1"; c="/control/$5"; skip_data_chown="${6:-0}"',
  'if [ -L "$c" ]; then echo "the control scope $5 is a link" >&2; exit 1; fi',
  'mkdir -p "$d" "$c"',
  'if [ ! -e "$d/data.img" ]; then',
  '  truncate -s "$2" "$d/data.img.tmp"',
  '  mkfs.ext4 -q -F -E lazy_itable_init=1,lazy_journal_init=1 "$d/data.img.tmp"',
  `  if [ "$skip_data_chown" != "1" ]; then chown ${String(HOST_VM_RUNNER_UID)}:${String(HOST_VM_RUNNER_UID)} "$d/data.img.tmp"; fi`,
  '  chmod 0600 "$d/data.img.tmp"',
  '  printf "%s\\n" "$3" > "$d/base-image-digest"',
  '  mv "$d/data.img.tmp" "$d/data.img"',
  // Says so on stdout: only a launch that made the disk may remove it when it fails.
  "  echo created",
  "fi",
  // Which control scope the runner mounts, beside its disk: a recovery or a removal, whichever
  // worker runs it, finds it there.
  'printf "%s\\n" "$5" > "$d/control-scope"',
  `if [ "$skip_data_chown" != "1" ]; then chown ${String(HOST_VM_RUNNER_UID)}:${String(HOST_VM_RUNNER_UID)} "$d"; fi`,
  'chmod 0755 "$d"',
  // The runner binds control.sock here as 65532; the setgid bit gives the socket the directory's
  // group, the one the worker shares, so the worker can connect.
  `chown ${String(HOST_VM_RUNNER_UID)}:"$4" "$c"`,
  'chmod 2770 "$c"',
].join("\n");

/**
 * The runner's data directory (`$1`, its name) and its control scope (`$2`). `$3` `keep`: the
 * caller's `capture.sock` and `session.sock` stay (a failed launch, whose next attempt finds them
 * bound), everything sealant staged goes, and the scope with it once it is empty. Otherwise the
 * whole scope goes (the executor is removed for good).
 */
const REMOVE_SCRIPT = [
  "set -eu",
  'd="/data/$1"; c="/control/$2"',
  'rm -rf "$d"',
  'if [ "$3" = keep ] && [ -d "$c" ] && [ ! -L "$c" ]; then',
  '  find "$c" -mindepth 1 -maxdepth 1 ! -name capture.sock ! -name session.sock -exec rm -rf {} +',
  '  rmdir "$c" 2>/dev/null || true',
  "else",
  '  rm -rf "$c"',
  "fi",
].join("\n");

/** Bounds on the containers that read untrusted input (an image's tar) or write as root. */
const UNTRUSTED_CONTAINER_LIMITS = [
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,noexec,size=64m",
  "--pids-limit",
  "64",
  "--memory",
  "2g",
  "--memory-swap",
  "2g",
] as const;

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
  /** Require `.mend-vm-data` sentinel inside `dataDir` before reporting a disk absent (macOS bind mounts). */
  readonly requireDataSentinel?: boolean;
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

  /** Where a control scope (a runner's name, or the one its launch named) is, as the worker sees it. */
  public controlPath(scope: string): string {
    return joinPath(this.#options.controlDir.path, assertContainerName(scope));
  }

  /**
   * The control scope a runner's data disk was prepared with (the marker beside it), or undefined
   * when there is none (a disk made before the marker): the runner's name, then.
   */
  public async markedControlScope(containerName: string): Promise<string | undefined> {
    const marker = joinPath(
      this.#options.dataDir.path,
      assertContainerName(containerName),
      "control-scope",
    );
    try {
      const scope = (await readFile(marker, "utf8")).trim();
      return CONTAINER_NAME_PATTERN.test(scope) ? scope : undefined;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
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

  /**
   * Whether a runner's data disk is there. Throws when the data directory itself is missing (an
   * unmounted volume, a moved directory): "no disk" must never be read off a filesystem that is not
   * there, or a retained executor's disk would be reported lost.
   */
  public async dataDiskExists(containerName: string): Promise<boolean> {
    if (!(await fileExists(this.#options.dataDir.path))) {
      throw Object.assign(
        new Error(
          `The host VM data directory ${this.#options.dataDir.path} is missing; is its volume mounted? Nothing can be said of any data disk until it is back.`,
        ),
        { code: "adapter-unavailable" },
      );
    }
    if (
      this.#options.requireDataSentinel === true &&
      !(await fileExists(joinPath(this.#options.dataDir.path, HOST_VM_DATA_SENTINEL)))
    ) {
      throw Object.assign(
        new Error(
          `The host VM data directory ${this.#options.dataDir.path} is missing its ${HOST_VM_DATA_SENTINEL} sentinel; is the macOS host directory mounted? Nothing can be said of any data disk until it is back.`,
        ),
        { code: "adapter-unavailable" },
      );
    }
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
      // Reused: fresh again for base-image GC, which keeps a young disk until a run's row names it.
      const now = new Date();
      await utimes(target.imagePath, now, now);
      await utimes(target.configPath, now, now);
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
    // The converter reads an untrusted tar: it gets a scratch directory of its own, never the
    // directory every base disk lives in, and runs as the scratch directory's owner (this worker)
    // with no capability at all. The finished disk is moved into place from here.
    const scratchName = temporaryName(target.key, ".d");
    const scratch = joinPath(this.#options.imagesDir.path, scratchName);
    await mkdir(scratch, { mode: 0o700 });
    const created = await run("docker", [
      "create",
      "--entrypoint",
      "/sealant-export-only",
      "--label",
      "sealant.host-vm.export=1",
      reference,
    ]).catch(async (error: unknown) => {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    });
    const containerId = created.stdout.trim();
    try {
      const owner = await stat(scratch);
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
          ...UNTRUSTED_CONTAINER_LIMITS,
          "--user",
          `${String(owner.uid)}:${String(owner.gid)}`,
          ...hostVmMountArgs(this.#options.imagesDir, scratchName, "/out", false),
          "--entrypoint",
          "sh",
          toolsImage,
          "-c",
          CONVERT_SCRIPT,
          "sealant-convert",
          "/out/disk.img",
          String(baseDiskBuildMiB(inspected.sizeBytes)),
        ],
        { timeoutMs: this.#options.convertTimeoutMs ?? 30 * 60_000 },
      );
      await rename(joinPath(scratch, "disk.img"), target.imagePath);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
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
   * the base image it was made for, and its control scope, owned by the runner's uid and the
   * control group (2770): whoever serves the caller's sockets there must be root or in that group.
   * Answers the data disk's path and whether this call made it.
   */
  public async prepareExecutor(input: {
    readonly containerName: string;
    readonly baseImageDigest: string;
    /** The control scope the runner mounts; defaults to its name. */
    readonly controlScope?: string;
  }): Promise<{ readonly dataDiskPath: string; readonly created: boolean }> {
    const name = assertContainerName(input.containerName);
    const scope = assertContainerName(input.controlScope ?? name);
    hostVmBaseImageKey(input.baseImageDigest);
    await mkdir(this.#options.dataDir.path, { recursive: true });
    await mkdir(this.#options.controlDir.path, { recursive: true });
    const group = this.#options.controlGroupId ?? (await stat(this.#options.controlDir.path)).gid;
    const skipDataChown = this.#options.dataDir.mount?.kind === "bind" ? "1" : "0";
    const output = await this.#runTools(PREPARE_SCRIPT, [
      name,
      String(this.#options.dataDiskBytes ?? DEFAULT_HOST_VM_DATA_DISK_BYTES),
      input.baseImageDigest,
      String(group),
      scope,
      skipDataChown,
    ]);
    return {
      dataDiskPath: this.dataDiskPath(name),
      created: output.split("\n").some((line) => line.trim() === "created"),
    };
  }

  /**
   * Delete a runner container's data disk and its control scope (`controlScope`, its name by
   * default). `keepCallerSockets`: the caller's `capture.sock` and `session.sock` there stay, for
   * the next launch of the same executor. Idempotent.
   */
  public async removeExecutor(
    containerName: string,
    options: { readonly controlScope?: string; readonly keepCallerSockets?: boolean } = {},
  ): Promise<void> {
    const name = assertContainerName(containerName);
    await this.#runTools(REMOVE_SCRIPT, [
      name,
      assertContainerName(options.controlScope ?? name),
      options.keepCallerSockets === true ? "keep" : "all",
    ]);
  }

  async #runTools(script: string, args: readonly string[]): Promise<string> {
    const toolsImage = await this.#ensureToolsImage();
    const result = await this.#options.commandRunner("docker", [
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
      ...UNTRUSTED_CONTAINER_LIMITS,
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
    return result.stdout;
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
