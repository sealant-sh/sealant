/**
 * A faithful in-memory Docker host for the `host-vm` runtime: the containers the adapter runs and
 * their states, the converter pipe and the disk-preparation container (which it carries out on
 * real temporary directories, as the tools container would), and a control channel that answers
 * `health` only while the runner container runs. Tests drive it through the adapter and read back
 * what a Docker host would hold.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { HostVmStorage, type DockerPipeRunner } from "../images/host-vm-disk.js";
import type { DockerCommandRunner } from "./docker-runtime-adapter.js";
import {
  HostVmRuntimeAdapter,
  type HostVmDiskRecord,
  type HostVmEgressProxy,
  type HostVmRuntimeAdapterOptions,
} from "./host-vm-runtime-adapter.js";
import type { ControlChannel } from "./kubernetes/adapter.js";

export const HOST_VM_DIGEST = `sha256:${"ab".repeat(32)}`;
export const HOST_VM_KEY = `sha256-${"ab".repeat(32)}`;
export const HOST_VM_REFERENCE = `127.0.0.1:5000/sealant/workspaces/demo@${HOST_VM_DIGEST}`;

const GiB = 1024 ** 3;

export interface FakeContainer {
  readonly name: string;
  readonly args: readonly string[];
  running: boolean;
  exitCode: number;
}

export interface HostVmHarness {
  readonly adapter: HostVmRuntimeAdapter;
  readonly storage: HostVmStorage;
  readonly root: string;
  readonly imagesDir: string;
  readonly dataDir: string;
  readonly controlDir: string;
  /** Every `docker` argv, in order. */
  readonly calls: string[][];
  /** Every converter pipe, `[from, to]`. */
  readonly pipes: Array<readonly [readonly string[], readonly string[]]>;
  readonly containers: Map<string, FakeContainer>;
  readonly records: Map<string, HostVmDiskRecord>;
  /** The order the disk record and the runner's `docker run` happened in. */
  readonly events: string[];
  readonly proxy: { started: string[]; parked: string[]; removed: string[] };
  /** Free bytes the data directory's filesystem reports. */
  freeBytes: number;
  /** When set, the next runner exits with this code before its daemon answers. */
  exitOnBoot: number | undefined;
  /** The next `docker inspect` of a container fails as an unreachable daemon does. */
  inspectFails: boolean;
  /** The next runner's `docker run` fails, creating nothing. */
  runFails: boolean;
  /** Images `docker image inspect` does not know until they are pulled. */
  readonly absentImages: Set<string>;
  /** The staged launch file each `docker run` of a runner found, by mode. */
  readonly stagedAtRun: Array<{ readonly mode: string; readonly launch: unknown }>;
  readonly cleanup: () => Promise<void>;
}

const ok = (stdout = "") => ({ stdout, stderr: "" });

/** The host directory a converter's argv mounts at /out. */
export const scratchOf = (argv: readonly string[]): string => {
  const mount = argv.find((arg) => arg.includes("target=/out")) ?? "";
  return /source=([^,]+)/.exec(mount)?.[1] ?? "";
};

const noSuch = (what: string): Error =>
  Object.assign(new Error(`Error response from daemon: No such ${what}`), {
    stderr: `Error response from daemon: No such ${what}`,
  });

export const createHostVmHarness = async (
  overrides: Partial<
    Omit<HostVmRuntimeAdapterOptions, "storage" | "diskRecords" | "commandRunner">
  > & {
    readonly withoutProxy?: boolean;
  } = {},
): Promise<HostVmHarness> => {
  const root = await mkdtemp(joinPath(tmpdir(), "sealant-host-vm-"));
  const imagesDir = joinPath(root, "images");
  const dataDir = joinPath(root, "data");
  const controlDir = joinPath(root, "control");
  await Promise.all([imagesDir, dataDir, controlDir].map((dir) => mkdir(dir, { recursive: true })));

  const calls: string[][] = [];
  const pipes: Array<readonly [readonly string[], readonly string[]]> = [];
  const containers = new Map<string, FakeContainer>();
  const records = new Map<string, HostVmDiskRecord>();
  const events: string[] = [];
  const stagedAtRun: Array<{ readonly mode: string; readonly launch: unknown }> = [];
  const absentImages = new Set<string>();
  const proxy = { started: [] as string[], parked: [] as string[], removed: [] as string[] };

  const harness = {
    root,
    imagesDir,
    dataDir,
    controlDir,
    calls,
    pipes,
    containers,
    records,
    events,
    proxy,
    freeBytes: 100 * GiB,
    exitOnBoot: undefined as number | undefined,
    inspectFails: false,
    runFails: false,
    absentImages,
    stagedAtRun,
  };

  const commandRunner: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    const [verb] = args;
    if (verb === "image" && args[1] === "inspect") {
      const reference = args.at(-1) ?? "";
      if (reference.startsWith("sealant-vm-disk-tools:")) return ok("sha256:tools\n");
      if (absentImages.has(reference)) throw noSuch(`image: ${reference}`);
      return ok(
        JSON.stringify({
          Size: 300 * 1024 * 1024,
          Config: {
            Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"],
            User: "",
            WorkingDir: "/workspace/repo",
            Entrypoint: ["/usr/local/bin/sealantd", "boot"],
            Cmd: null,
            Labels: { "sh.sealant.plan-hash": "abc" },
          },
        }),
      );
    }
    if (verb === "pull") {
      absentImages.delete(args[1] ?? "");
      return ok();
    }
    if (verb === "create") return ok("export-container\n");
    if (verb === "info") return ok(String(16 * GiB));
    if (verb === "ps") {
      const digests = [...containers.values()].flatMap((container) => {
        const label = container.args.find((arg) => arg.startsWith("sealant.host-vm.base-image="));
        return label === undefined ? [] : [label.slice(label.indexOf("=") + 1)];
      });
      return ok(digests.join("\n"));
    }
    if (verb === "inspect") {
      if (harness.inspectFails) {
        harness.inspectFails = false;
        throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      }
      const container = containers.get(args.at(-1) ?? "");
      if (container === undefined) throw noSuch(`container: ${args.at(-1) ?? ""}`);
      return ok(
        JSON.stringify({
          Status: container.running ? "running" : "exited",
          Running: container.running,
          ExitCode: container.exitCode,
          Error: "",
        }),
      );
    }
    if (verb === "logs") return ok("cloud-hypervisor started\n");
    if (verb === "rm") {
      const name = args.at(-1) ?? "";
      if (name === "export-container") return ok();
      if (!containers.delete(name)) throw noSuch(`container: ${name}`);
      return ok();
    }
    if (verb === "stop" || verb === "kill") {
      const container = containers.get(args.at(-1) ?? "");
      if (container === undefined) throw noSuch(`container: ${args.at(-1) ?? ""}`);
      if (container.running) {
        container.running = false;
        container.exitCode = verb === "kill" ? 137 : 0;
      }
      return ok();
    }
    if (verb === "run" && args.includes("--rm")) {
      // The tools container: carry out its script on the real directories.
      const script = args[args.indexOf("-c") + 1] ?? "";
      const positional = args.slice(args.indexOf("-c") + 3);
      const [name = "", , digest = ""] = positional;
      if (script.includes("mkfs.ext4")) {
        await mkdir(joinPath(dataDir, name), { recursive: true });
        await mkdir(joinPath(controlDir, name), { recursive: true });
        const disk = joinPath(dataDir, name, "data.img");
        const exists = await access(disk).then(
          () => true,
          () => false,
        );
        if (!exists) {
          await writeFile(disk, "ext4");
          await writeFile(joinPath(dataDir, name, "base-image-digest"), `${digest}\n`);
          return ok("created\n");
        }
      } else if (script.includes("rm -rf")) {
        await rm(joinPath(dataDir, name), { recursive: true, force: true });
        await rm(joinPath(controlDir, name), { recursive: true, force: true });
      }
      return ok();
    }
    if (verb === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      if (harness.runFails) {
        harness.runFails = false;
        throw new Error("docker: Error response from daemon: failed to create task");
      }
      if (containers.has(name))
        throw new Error(`Conflict. The container name "/${name}" is already in use`);
      events.push(`run:${name}`);
      const mode = args[args.indexOf("--mode") + 1] ?? "";
      const launchFile = mode === "recover" ? "recovery-env.json" : "boot-env.json";
      const launch = await readFile(joinPath(controlDir, name, launchFile), "utf8").then(
        (text): unknown => JSON.parse(text),
        () => undefined,
      );
      stagedAtRun.push({ mode, launch });
      containers.set(name, { name, args: [...args], running: true, exitCode: 0 });
      return ok(`${name}-id\n`);
    }
    return ok();
  };

  const pipeRunner: DockerPipeRunner = async (from, to) => {
    pipes.push([from, to]);
    // The converter writes `disk.img` into the scratch directory mounted at /out.
    await writeFile(joinPath(scratchOf(to), "disk.img"), "ext4-base");
    return { stdout: "", stderr: "" };
  };

  const storage = new HostVmStorage({
    imagesDir: { path: imagesDir },
    dataDir: { path: dataDir },
    controlDir: { path: controlDir },
    commandRunner,
    pipeRunner,
    freeBytes: async () => harness.freeBytes,
  });

  const controlChannel: ControlChannel = {
    health: async (target) => {
      if (target.kind !== "unix-socket") throw new Error("not a socket target");
      const name = target.socketPath.split("/").at(-2) ?? "";
      const container = containers.get(name);
      if (container !== undefined && container.running && harness.exitOnBoot !== undefined) {
        container.running = false;
        container.exitCode = harness.exitOnBoot;
        harness.exitOnBoot = undefined;
      }
      if (container === undefined || !container.running) throw new Error("connection closed");
    },
    writeCredentialFiles: async () => undefined,
  };

  const egressProxy: HostVmEgressProxy = {
    start: async ({ containerName }) => {
      proxy.started.push(containerName);
      return { network: `mend-egress-${containerName}`, proxyIp: "172.30.0.3" };
    },
    park: async (containerName) => {
      proxy.parked.push(containerName);
      return true;
    },
    remove: async (containerName) => {
      proxy.removed.push(containerName);
    },
  };

  const { withoutProxy, ...adapterOverrides } = overrides;
  const adapter = new HostVmRuntimeAdapter({
    storage,
    diskRecords: {
      record: async ({ runId, ...record }) => {
        events.push(`record:${runId}`);
        records.set(runId, record);
      },
      load: async (runId) => records.get(runId),
    },
    commandRunner,
    runnerImage: "ghcr.io/sealant-sh/vm-runner:test",
    controlChannel,
    readinessTimeoutMs: 2_000,
    ...(withoutProxy === true ? {} : { egressProxy }),
    ...adapterOverrides,
  });

  return Object.assign(harness, {
    adapter,
    storage,
    cleanup: () => rm(root, { recursive: true, force: true }),
  });
};
