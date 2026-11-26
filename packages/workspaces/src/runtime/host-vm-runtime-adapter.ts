/**
 * The `host-vm` runtime (agent-home `docs/workspace-isolation-architecture.md` §3.1, §4.2, §6): each
 * workspace runs as its own Cloud Hypervisor microVM on this Docker host's KVM, inside one
 * `sealant-vm-runner` container (`<name>`). The worker never enters the VM: it builds the disks
 * (`HostVmStorage`), stages the launch files the runner reads into the container's control
 * directory, starts the runner in its jail, and reaches sealantd through the runner's
 * `control.sock`, which the runner bridges to the guest's vsock port 1024.
 *
 * The runner's contract is sealantd's `crates/sealant-vm-runner` (`main.rs`, `protocol.rs`), and
 * everything this module writes for it follows that code exactly:
 *
 *  - **Jail**: `--cap-drop ALL` plus exactly `NET_ADMIN`, `SETUID`, `SETGID`, `SETPCAP` (spent
 *    once by the runner before it drops to 65532), `no-new-privileges`, `/dev/kvm` and
 *    `/dev/net/tun`, a read-only root with tmpfs `/tmp` and `/run/vm`. Never `--privileged`, never
 *    the Docker socket, never `mend_default`.
 *  - **Mounts**: the one base disk `<key>.img` read-only at `/var/lib/sealant/images/<key>.img`,
 *    the container's data directory at `/var/lib/sealant/data` (`data.img`), and its control
 *    scope at `/run/sealant`, where the runner binds `control.sock`, reads the staged files and
 *    relays the guest's vsock 1025 and 1027 to the caller's `capture.sock` and `session.sock`
 *    (1025 only on a recovery). The scope is the launch's `controlScope`, else the container's
 *    name; it is marked beside the data disk, so a recovery and the removal find it. Launch and
 *    recovery never remove the caller's two sockets, which it may bind before either.
 *  - **Staged files** in the control directory: `<key>.config.json` (the image's saved OCI config),
 *    `boot-env.json` for a normal boot or `recovery-env.json` for a recovery
 *    (`{"mode","bootEnv","secretEnv","dockerd","dotfilesArchive"}`), and `executor-ca.pem` when the
 *    egress proxy gives the executor a CA.
 *  - **Memory**: the guest gets the workspace memory limit (plus the Docker service's, since its
 *    `dockerd` runs inside the guest); the container gets that plus 512 MiB for the VMM and runner.
 *  - **Stop**: `docker stop -t` longer than the runner's `--shutdown-grace-secs`, so the guest's
 *    final flush and its `sync()` finish before anything is killed.
 *
 * **Recovery survives a container prune.** The runner's boot mode is a command-line flag fixed at
 * `docker run`, and the container holds nothing (read-only root, tmpfs): everything the workspace
 * wrote is in `data.img`, whose path and base image digest are on the run's row in Postgres before
 * the container exists. So `recover` always runs a fresh runner in `--mode recover` on those two
 * disks, after removing a stopped container if one is left: one path whether or not
 * `docker container prune` took it. The recovery runner has no network, no proxy and no session
 * channel; only `control.sock` (status and the final flush), the capture relay and the boot channel.
 * For the same reason the executor's `resourceId` is its container NAME, which a recreated runner
 * keeps, not the container id, which it does not.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join as joinPath, posix } from "node:path";

import { z } from "zod";

import {
  hostVmBaseImageKey,
  hostVmMountArgs,
  HOST_VM_RUNNER_UID,
  type HostVmBaseImage,
  type HostVmStorage,
} from "../images/host-vm-disk.js";
import {
  type DaemonSentryConfig,
  type DaemonTelemetry,
  withLaunchTelemetry,
} from "./daemon-telemetry.js";
import {
  probeIsolatedGatewaySupport,
  type IsolatedGatewaySupport,
} from "./docker-isolated-network.js";
import {
  AUTO_DOCKER_MEMORY_POLICY,
  dockerMemoryArgs,
  parseDockerHostMemory,
  resolveDockerMemoryLimits,
  type DockerMemoryLimits,
  type DockerMemoryPolicy,
} from "./docker-memory-limits.js";
import {
  DEFAULT_NETWORK_GUARD_IMAGE,
  isDaemonErrorResponse,
  isNoSuchContainerError,
  normalizeContainerToken,
  type DockerCommandRunner,
  type DockerEventStream,
  type DockerEventStreamOpener,
} from "./docker-runtime-adapter.js";
import type { EgressProxyOrchestrator } from "./egress-proxy-orchestrator.js";
import { liveControlChannel, type ControlChannel } from "./kubernetes/adapter.js";
import {
  completeReadyLaunch,
  failLaunch,
  launchHoldsCaptures,
  reportStartedLaunch,
  type RuntimeAdapterLaunchHooks,
  type RuntimeLaunchIdentity,
} from "./launch-retention.js";
import { nativeBootEnv } from "./native-boot-env.js";
import {
  nothingToSaveDetail,
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterLaunchResult,
  parseRuntimeAdapterStopInput,
  parseRuntimeAdapterStopResult,
  parseRuntimeAdapterSupport,
  parseRuntimeAdapterSupportInput,
  removalRefused,
  SEALANTD_EXIT_NOTHING_TO_SAVE,
  type RuntimeAdapter,
  type RuntimeAdapterExitWatch,
  type RuntimeAdapterExitWatchInput,
  type RuntimeAdapterInspectInput,
  type RuntimeAdapterInspectResult,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterParkInput,
  type RuntimeAdapterParkResult,
  type RuntimeAdapterRecoverInput,
  type RuntimeAdapterRecoverResult,
  type RuntimeAdapterStopInput,
  type RuntimeAdapterStopResult,
  type RuntimeAdapterSupport,
  type RuntimeAdapterSupportInput,
} from "./runtime-adapter.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * The `sealant-vm-runner` image a host VM runs in: sealantd's multi-arch `vm-runner-next`, pinned
 * by digest to the same build as the guest's sealantd (`buildkit-builder.ts`), since the runner and
 * `sealantd --vm` speak one boot protocol. `SEALANT_VM_RUNNER_IMAGE` replaces it.
 */
export const DEFAULT_HOST_VM_RUNNER_IMAGE =
  "ghcr.io/sealant-sh/vm-runner-next:0.21.0-next.217@sha256:5d980937731275b900421366e9df2bb43893d8c33b37634f87dcca8a6f32bd7b";

/** Where the runner reads its disks and staged files (`sealant-vm-runner` defaults). */
export const HOST_VM_IMAGES_TARGET = "/var/lib/sealant/images";
export const HOST_VM_DATA_TARGET = "/var/lib/sealant/data";
export const HOST_VM_CONTROL_TARGET = "/run/sealant";

/** The runner's own default; how long the guest has to power off after SIGTERM. */
export const DEFAULT_HOST_VM_SHUTDOWN_GRACE_SECONDS = 20;
/** `docker stop -t`: past the grace by enough for the VMM's exit and the runner's own. */
export const DEFAULT_HOST_VM_STOP_TIMEOUT_SECONDS = 35;
/** What the VMM and the runner take beside the guest's memory (§4.2; calibrated in Milestone 1). */
export const HOST_VM_CONTAINER_OVERHEAD_BYTES = 512 * MiB;
/** A guest's memory when the install sets no workspace limit (`none`). */
const DEFAULT_GUEST_BYTES = 4 * GiB;
/** The guest `dockerd`'s share when the install sets no Docker service limit (`none`). */
const DEFAULT_GUEST_DOCKER_BYTES = 2 * GiB;
const DEFAULT_VCPUS = 2;
const DEFAULT_CONTAINER_PREFIX = "sealant-vm";
const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const READINESS_POLL_MS = 500;
const HEALTH_ATTEMPT_MS = 10_000;
const EVENT_STREAM_RECONNECT_MIN_MS = 1_000;
const EVENT_STREAM_RECONNECT_MAX_MS = 30_000;

/** Labels on every runner container. Base-image GC reads the digest one. */
export const HOST_VM_LABEL = "sealant.host-vm";
export const HOST_VM_BASE_IMAGE_LABEL = "sealant.host-vm.base-image";
const HOST_VM_MODE_LABEL = "sealant.host-vm.mode";

/** The guest `dockerd`'s socket (sealantd `vm/env.rs` `GUEST_DOCKER_HOST`). */
const GUEST_DOCKER_HOST = "unix:///var/run/docker.sock";

/** The runner's staged launch file for each boot mode (`protocol.rs` `StagedFiles::new`). */
const LAUNCH_FILE = { normal: "boot-env.json", recover: "recovery-env.json" } as const;
const EXECUTOR_CA_FILE = "executor-ca.pem";

export type HostVmBootMode = keyof typeof LAUNCH_FILE;

/**
 * A staged launch file (`protocol.rs` `StagedLaunch`): camelCase, `mode` naming the boot it is for
 * (the runner refuses a file staged for the other mode).
 */
export interface HostVmStagedLaunch {
  readonly mode: HostVmBootMode;
  readonly bootEnv: Readonly<Record<string, string>>;
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly dockerd: boolean;
  readonly dotfilesArchive?: { readonly files: Readonly<Record<string, string>> };
  /** The daemon's trace and Sentry project, which the runner hands the guest (sealantd #250). */
  readonly telemetry?: DaemonTelemetry;
}

const stagedLaunchSchema = z.object({
  mode: z.enum(["normal", "recover"]),
  bootEnv: z.record(z.string(), z.string()),
  secretEnv: z.record(z.string(), z.string()),
  dockerd: z.boolean(),
});

/** A `host-vm` executor's disks as the run's row records them (`recordHostVmDisk`). */
export interface HostVmDiskRecord {
  readonly dataDiskPath: string;
  readonly baseImageDigest: string;
}

/** What a runner's own firewall lets out, fixed at `docker run` (`hostVmEgressFlags`). */
export interface HostVmRunnerEgress {
  readonly mode: "standard" | "restricted";
  readonly allowTcpPorts: readonly number[];
}

/** Where the adapter keeps each executor's disks, durably: the run's runtime row in Postgres. */
export interface HostVmDiskRecords {
  /** Written before the runner container is created; a failure fails the launch. */
  readonly record: (
    input: HostVmDiskRecord & {
      readonly runId: string;
      readonly runnerEgress?: HostVmRunnerEgress;
    },
  ) => Promise<void>;
  readonly load: (runId: string) => Promise<HostVmDiskRecord | undefined>;
}

/**
 * The per-workspace egress proxy (`<name>-proxy`, §3.1, §7) the runner sends every guest packet
 * to, run by the egress proxy orchestrator the Docker runtime shares. Every host VM boots behind
 * one, whatever its policy: the runner's normal boot needs `--proxy-ip`, and the VM has no other
 * way out. Without it, `host-vm` launches nothing.
 */
export interface HostVmEgressProxyOptions {
  readonly proxies: EgressProxyOrchestrator;
  /**
   * The operator's private ranges a proxy lets through and the host's own public addresses it
   * refuses (`SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS`, `SEALANT_HOST_PUBLIC_IPS`), measured when a
   * launch needs them.
   */
  readonly hostPolicy: () => Promise<{
    readonly operatorAllowedPrivateCidrs: readonly string[];
    readonly hostPublicIps: readonly string[];
  }>;
  /** Test seam: whether this engine makes `gateway_mode_ipv4=isolated` networks (probed once). */
  readonly isolatedGatewayProbe?: () => Promise<IsolatedGatewaySupport>;
}

/** What the runner is told of its proxy. */
interface HostVmEgressAttachment {
  /** The workspace's `--internal`, gateway-isolated network the runner joins alone with its proxy. */
  readonly network: string;
  /** `<name>-proxy`'s address on it (`--proxy-ip`). */
  readonly proxyIp: string;
  readonly egress: "standard" | "restricted";
  /** TCP ports `restricted` allows besides 80 and 443. */
  readonly allowTcpPorts: readonly number[];
}

/** What of a network policy (a spec's, or one applied later) decides a runner's firewall. */
export interface HostVmPolicyPorts {
  readonly mode: "standard" | "restricted";
  readonly allowHosts?:
    | ReadonlyArray<{ readonly host: string; readonly ports?: ReadonlyArray<number> | undefined }>
    | undefined;
  readonly allowMirrors?:
    | ReadonlyArray<{ readonly name: string; readonly port: number }>
    | undefined;
}

/**
 * Whether `policy`, applied to a running host VM, lets out something its runner's firewall does
 * not: the runner takes its mode and ports once, at `docker run`, so its proxy can take a wider
 * policy at once while the VM's packets for the new ports are still dropped before they reach
 * it. Such a policy holds from the next start. A narrower one holds now: the proxy refuses what
 * the runner still forwards. Nothing recorded (`launched` absent) is unknown, and treated as
 * wider.
 */
export const hostVmRunnerWidens = (
  launched: HostVmRunnerEgress | null | undefined,
  policy: HostVmPolicyPorts | undefined,
): boolean => {
  if (launched === null || launched === undefined) return true;
  if (launched.mode === "standard") return false;
  const next = hostVmEgressFlags(policy);
  if (next.egress === "standard") return true;
  const allowed = new Set(launched.allowTcpPorts);
  return next.allowTcpPorts.some((port) => !allowed.has(port));
};

/**
 * The runner's egress flags from the workspace's policy: `restricted` lets through 80, 443 and
 * the TCP ports its allowed hosts and mirrors name; anything else is `standard`.
 */
export const hostVmEgressFlags = (
  policy: HostVmPolicyPorts | undefined,
): Pick<HostVmEgressAttachment, "egress" | "allowTcpPorts"> => {
  if (policy?.mode !== "restricted") return { egress: "standard", allowTcpPorts: [] };
  const ports = new Set<number>();
  for (const host of policy.allowHosts ?? []) for (const port of host.ports ?? []) ports.add(port);
  for (const mirror of policy.allowMirrors ?? []) ports.add(mirror.port);
  ports.delete(80);
  ports.delete(443);
  return { egress: "restricted", allowTcpPorts: [...ports].toSorted((a, b) => a - b) };
};

export interface HostVmRuntimeAdapterOptions {
  /**
   * Where each guest's sealantd reports (`SEALANTD_SENTRY_DSN`), staged as `boot-env.json`'s
   * `telemetry` with the launching span. Absent: the guest joins the launch's trace and exports
   * nothing unless the runner's own `SENTRY_*` says otherwise.
   */
  readonly daemonTelemetry?: DaemonSentryConfig;
  readonly storage: HostVmStorage;
  readonly diskRecords: HostVmDiskRecords;
  readonly commandRunner: DockerCommandRunner;
  /** The runner image (`SEALANT_VM_RUNNER_IMAGE`); defaults to `DEFAULT_HOST_VM_RUNNER_IMAGE`. */
  readonly runnerImage?: string;
  readonly egressProxy?: HostVmEgressProxyOptions;
  /** The same policy Docker workspaces use (`SEALANT_DOCKER_*_MEMORY_LIMIT`); `auto` by default. */
  readonly memory?: DockerMemoryPolicy;
  readonly vcpus?: number;
  readonly shutdownGraceSeconds?: number;
  /** Must be longer than `shutdownGraceSeconds`. */
  readonly stopTimeoutSeconds?: number;
  /** `/dev/kvm`'s group, when the runner cannot read it from the device (`--kvm-gid`). */
  readonly kvmGid?: number;
  readonly containerNamePrefix?: string;
  readonly readinessTimeoutMs?: number;
  /** Test seam: the control channel (health, credential files). */
  readonly controlChannel?: ControlChannel;
  /** The `docker events` stream for `watchExits`; absent, `watchExits` is not offered. */
  readonly eventStreamOpener?: DockerEventStreamOpener;
}

/** The guest's memory and the container's limit, from the install's memory limits. */
export const hostVmMemory = (
  limits: DockerMemoryLimits,
  dockerService: boolean,
): { readonly guestMib: number; readonly containerBytes: number } => {
  const guestBytes =
    (limits.workspace ?? DEFAULT_GUEST_BYTES) +
    (dockerService ? (limits.service ?? DEFAULT_GUEST_DOCKER_BYTES) : 0);
  const guestMib = Math.floor(guestBytes / MiB);
  return { guestMib, containerBytes: guestMib * MiB + HOST_VM_CONTAINER_OVERHEAD_BYTES };
};

const createAdapterError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <A>(promise: Promise<A>, ms: number, what: string): Promise<A> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${String(ms)} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Write `content` to `path` by a rename, so the runner never reads half a file. The control
 * directory is shared with the runner's uid: the temporary name is random and created exclusively
 * (`O_CREAT|O_EXCL`, never through a link planted there), and `rename` replaces whatever is at
 * `path` itself rather than following it.
 */
const writeAtomically = async (path: string, content: string, mode: number): Promise<void> => {
  const temporary = `${path}.tmp-${randomBytes(12).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const no = (
  reason: "unsupported-runtime" | "unsupported-runtime-requirement" | "adapter-unavailable",
  message: string,
): RuntimeAdapterSupport => parseRuntimeAdapterSupport({ supported: false, reason, message });

const supportFor = (input: RuntimeAdapterSupportInput, proxied: boolean): RuntimeAdapterSupport => {
  const { blueprint } = input;
  const family = blueprint.target.runtime.family;
  if (family !== "auto" && family !== "host-vm") {
    return no(
      "unsupported-runtime",
      "The host VM runtime adapter only supports target.runtime.family of auto or host-vm.",
    );
  }
  if (!proxied) {
    return no(
      "adapter-unavailable",
      "This worker has no egress proxy for host VM workspaces, and a host VM boots only behind one. Configure the egress proxy, or use the docker runtime.",
    );
  }
  if (blueprint.runtime.persistence !== "ephemeral") {
    return no(
      "unsupported-runtime-requirement",
      "The host VM runtime adapter currently supports only ephemeral workspaces.",
    );
  }
  if (!blueprint.runtime.network.outbound) {
    return no(
      "unsupported-runtime-requirement",
      "The host VM runtime adapter currently requires outbound network access.",
    );
  }
  if (blueprint.runtime.network.cloudMetadata) {
    return no(
      "unsupported-runtime-requirement",
      "A host VM workspace never reaches the cloud metadata address: its egress proxy refuses it. Turn runtime.network.cloudMetadata off.",
    );
  }
  if (blueprint.runtime.ociRuntime === "runsc") {
    return no(
      "unsupported-runtime-requirement",
      "A host VM workspace cannot run under gVisor (runsc): the VM itself isolates the workspace. Use runc.",
    );
  }
  const source = blueprint.sources.workspace;
  if (source.kind === "mount" || source.kind === "standby" || blueprint.sources.mounts.length > 0) {
    return no(
      "unsupported-runtime-requirement",
      "A host VM workspace cannot bind directories from this deployment's servers. Start it from a capture or a repository instead.",
    );
  }
  if (
    blueprint.runtime.envFrom.length > 0 ||
    blueprint.runtime.kubernetes.serviceAccountName !== undefined
  ) {
    return no(
      "unsupported-runtime-requirement",
      "Cluster env references (runtime.envFrom, kubernetes.serviceAccountName) resolve only on Kubernetes runtimes.",
    );
  }
  if (
    blueprint.tooling.services?.docker?.enabled === true &&
    blueprint.target.os.family === "custom"
  ) {
    return no(
      "unsupported-runtime-requirement",
      "Docker inside a host VM workspace needs a managed base image (Ubuntu, Fedora, Arch or Nix): the guest's engine is installed with the family's own packages. Choose a managed OS family, or turn Docker off.",
    );
  }
  if (source.kind === "capture") {
    const outside = [
      ["runtime.workspaceRoot", blueprint.runtime.workspaceRoot],
      ["runtime.workingDirectory", blueprint.runtime.workingDirectory],
      ...(source.harnessHome === undefined
        ? []
        : [["sources.workspace.harnessHome", source.harnessHome] as const]),
    ].filter(([, path]) => !underRecoveredRoot(path));
    if (outside.length > 0) {
      return no(
        "unsupported-runtime-requirement",
        `A host VM's recovery boot keeps only /workspace and /home of its data disk, so a capture workspace's paths must lie under one of them; ${outside.map(([field, path]) => `${field} is ${path}`).join(", ")}.`,
      );
    }
  }
  return parseRuntimeAdapterSupport({ supported: true });
};

/** The data-disk directories a recovery boot binds back in (sealantd `vm/layout.rs` `recovery`). */
const RECOVERED_ROOTS = ["/workspace", "/home"] as const;

/** Whether `path` is a recovered root or below one, with no `.` or `..` segment to escape it. */
export const underRecoveredRoot = (path: string): boolean => {
  if (!path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) {
    return false;
  }
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  return RECOVERED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
};

/** The container state `docker inspect` reports, or `absent`. */
type ContainerState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly running: boolean;
      readonly status: string;
      readonly exitCode: number;
      readonly error: string;
    };

const containerStateSchema = z.object({
  Status: z.string(),
  Running: z.boolean(),
  ExitCode: z.number().int(),
  Error: z.string().optional(),
});

export class HostVmRuntimeAdapter implements RuntimeAdapter {
  public readonly id = "host-vm" as const;
  /** An ended runner leaves its data disk (and its stopped container) for the remove phase. */
  public readonly keepsRemains = true;
  /** Every runner mounts its own control scope at `/run/sealant`. */
  public readonly hasControlScopes = true;

  readonly #storage: HostVmStorage;
  readonly #records: HostVmDiskRecords;
  readonly #run: DockerCommandRunner;
  readonly #runnerImage: string;
  readonly #egressProxy: HostVmEgressProxyOptions | undefined;
  readonly #daemonTelemetry: DaemonSentryConfig | undefined;
  #isolatedGatewayProved = false;
  readonly #memoryPolicy: DockerMemoryPolicy;
  readonly #vcpus: number;
  readonly #shutdownGraceSeconds: number;
  readonly #stopTimeoutSeconds: number;
  readonly #kvmGid: number | undefined;
  readonly #prefix: string;
  readonly #readinessTimeoutMs: number;
  readonly #control: ControlChannel;
  readonly #eventStreamOpener: DockerEventStreamOpener | undefined;
  #memoryLimits: DockerMemoryLimits | undefined;

  public constructor(options: HostVmRuntimeAdapterOptions) {
    this.#storage = options.storage;
    this.#records = options.diskRecords;
    this.#run = options.commandRunner;
    this.#runnerImage = options.runnerImage ?? DEFAULT_HOST_VM_RUNNER_IMAGE;
    this.#egressProxy = options.egressProxy;
    this.#daemonTelemetry = options.daemonTelemetry;
    this.#memoryPolicy = options.memory ?? AUTO_DOCKER_MEMORY_POLICY;
    this.#vcpus = options.vcpus ?? DEFAULT_VCPUS;
    this.#shutdownGraceSeconds =
      options.shutdownGraceSeconds ?? DEFAULT_HOST_VM_SHUTDOWN_GRACE_SECONDS;
    this.#stopTimeoutSeconds = options.stopTimeoutSeconds ?? DEFAULT_HOST_VM_STOP_TIMEOUT_SECONDS;
    if (this.#stopTimeoutSeconds <= this.#shutdownGraceSeconds) {
      // A stop that kills the runner inside its own grace cuts off the guest's final flush.
      throw new Error(
        `The host VM stop timeout (${String(this.#stopTimeoutSeconds)} s) must be longer than the runner's shutdown grace (${String(this.#shutdownGraceSeconds)} s).`,
      );
    }
    this.#kvmGid = options.kvmGid;
    this.#prefix = options.containerNamePrefix ?? DEFAULT_CONTAINER_PREFIX;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#control = options.controlChannel ?? liveControlChannel;
    this.#eventStreamOpener = options.eventStreamOpener;
  }

  public supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    return supportFor(parseRuntimeAdapterSupportInput(input), this.#egressProxy !== undefined);
  }

  /** The egress proxies this adapter runs, for the worker's lease and revocation sweep. */
  public get egressProxies(): EgressProxyOrchestrator | undefined {
    return this.#egressProxy?.proxies;
  }

  async #assertIsolatedGatewaySupport(egress: HostVmEgressProxyOptions): Promise<void> {
    if (this.#isolatedGatewayProved) return;
    const verdict = await (
      egress.isolatedGatewayProbe ??
      (() => probeIsolatedGatewaySupport({ run: this.#run, image: DEFAULT_NETWORK_GUARD_IMAGE }))
    )();
    if (!verdict.supported) {
      throw createAdapterError(
        "adapter-unavailable",
        `This Docker host cannot isolate a host VM behind its egress proxy: ${verdict.reason}`,
      );
    }
    this.#isolatedGatewayProved = true;
  }

  /** The runner container's name for a run: one container per run, recreated under one name. */
  public containerName(runId: string): string {
    return `${this.#prefix}-${normalizeContainerToken(runId) || "run"}`;
  }

  /** The runner's `control.sock`, in its control scope. */
  #endpoint(scope: string): string {
    return `unix://${joinPath(this.#storage.controlPath(scope), "control.sock")}`;
  }

  #identity(name: string, scope: string): RuntimeLaunchIdentity {
    return {
      adapter: this.id,
      resourceId: name,
      reference: name,
      endpoint: this.#endpoint(scope),
      controlScope: scope,
    };
  }

  /** The control scope a runner's disk was prepared with: the marker, else the runner's name. */
  async #scopeOf(name: string): Promise<string> {
    return (await this.#storage.markedControlScope(name)) ?? name;
  }

  async #containerState(name: string): Promise<ContainerState> {
    try {
      const result = await this.#run("docker", ["inspect", "--format", "{{json .State}}", name]);
      const state = containerStateSchema.parse(JSON.parse(result.stdout));
      return {
        kind: "present",
        running: state.Running,
        status: state.Status,
        exitCode: state.ExitCode,
        error: state.Error ?? "",
      };
    } catch (error) {
      if (isNoSuchContainerError(error)) return { kind: "absent" };
      throw error;
    }
  }

  async #logs(name: string): Promise<string | undefined> {
    try {
      const result = await this.#run("docker", ["logs", "--tail", "60", name]);
      const text = `${result.stdout}${result.stderr}`.trim();
      return text.length === 0 ? undefined : text;
    } catch {
      return undefined;
    }
  }

  async #limits(): Promise<DockerMemoryLimits> {
    if (this.#memoryLimits !== undefined) return this.#memoryLimits;
    const needsHost =
      this.#memoryPolicy.workspace.kind === "auto" || this.#memoryPolicy.service.kind === "auto";
    const host = needsHost
      ? await this.#run("docker", ["info", "--format", "{{json .MemTotal}}"]).then(
          (result) => parseDockerHostMemory(result.stdout),
          () => undefined,
        )
      : undefined;
    const limits = resolveDockerMemoryLimits(this.#memoryPolicy, host);
    if (!needsHost || host !== undefined) this.#memoryLimits = limits;
    return limits;
  }

  /** Stage the files the runner reads (`protocol.rs`) in the runner's control scope. */
  async #stage(
    scope: string,
    base: HostVmBaseImage,
    files: {
      readonly launch?: HostVmStagedLaunch;
      readonly recoveryTemplate?: HostVmStagedLaunch;
      readonly executorCaPem?: string;
    },
  ): Promise<void> {
    const control = this.#storage.controlPath(scope);
    // Only the base disk itself is mounted into the runner: its config is staged beside the
    // launch file, the first place the runner looks for it.
    const config = await readFile(base.configPath, "utf8");
    await writeAtomically(joinPath(control, `${base.key}.config.json`), config, 0o644);
    if (files.launch !== undefined) {
      await writeAtomically(
        joinPath(control, LAUNCH_FILE[files.launch.mode]),
        `${JSON.stringify(files.launch)}\n`,
        // The runner reads it as uid 65532 through the directory it owns; nobody else can reach
        // the directory (2770).
        0o644,
      );
    }
    if (files.recoveryTemplate !== undefined) {
      await writeAtomically(
        joinPath(control, LAUNCH_FILE.recover),
        `${JSON.stringify(files.recoveryTemplate)}\n`,
        0o644,
      );
    }
    if (files.executorCaPem !== undefined) {
      await writeAtomically(joinPath(control, EXECUTOR_CA_FILE), files.executorCaPem, 0o644);
    }
  }

  /** The `docker run` argv of a runner container. */
  #runArgs(input: {
    readonly name: string;
    readonly controlScope: string;
    readonly mode: HostVmBootMode;
    readonly baseImageDigest: string;
    readonly guestMib: number;
    readonly containerBytes: number;
    readonly runId?: string;
    readonly egress?: HostVmEgressAttachment;
  }): string[] {
    const key = hostVmBaseImageKey(input.baseImageDigest);
    const tmpfs = `rw,nosuid,nodev,noexec,uid=${String(HOST_VM_RUNNER_UID)},gid=${String(HOST_VM_RUNNER_UID)}`;
    return [
      "run",
      "-d",
      "--name",
      input.name,
      "--label",
      `${HOST_VM_LABEL}=1`,
      "--label",
      `${HOST_VM_BASE_IMAGE_LABEL}=${input.baseImageDigest}`,
      "--label",
      `${HOST_VM_MODE_LABEL}=${input.mode}`,
      ...(input.runId === undefined ? [] : ["--label", `sealant.run=${input.runId}`]),
      "--stop-timeout",
      String(this.#stopTimeoutSeconds),
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETPCAP",
      "--security-opt",
      "no-new-privileges:true",
      "--device",
      "/dev/kvm:/dev/kvm",
      "--device",
      "/dev/net/tun:/dev/net/tun",
      "--read-only",
      "--tmpfs",
      `/tmp:${tmpfs}`,
      "--tmpfs",
      `/run/vm:${tmpfs}`,
      "--pids-limit",
      "256",
      "--cpus",
      String(this.#vcpus),
      ...dockerMemoryArgs(input.containerBytes),
      // A recovery has no egress at all: no network, no proxy.
      "--network",
      input.egress?.network ?? "none",
      ...hostVmMountArgs(
        this.#storage.imagesDir,
        `${key}.img`,
        `${HOST_VM_IMAGES_TARGET}/${key}.img`,
        true,
      ),
      ...hostVmMountArgs(this.#storage.dataDir, input.name, HOST_VM_DATA_TARGET, false),
      ...hostVmMountArgs(
        this.#storage.controlDir,
        input.controlScope,
        HOST_VM_CONTROL_TARGET,
        false,
      ),
      this.#runnerImage,
      "--mode",
      input.mode,
      "--image-digest",
      key,
      "--vcpus",
      String(this.#vcpus),
      "--memory-mib",
      String(input.guestMib),
      "--shutdown-grace-secs",
      String(this.#shutdownGraceSeconds),
      ...(this.#kvmGid === undefined ? [] : ["--kvm-gid", String(this.#kvmGid)]),
      ...(input.egress === undefined
        ? []
        : [
            "--proxy-ip",
            input.egress.proxyIp,
            "--egress",
            input.egress.egress,
            ...input.egress.allowTcpPorts.flatMap((port) => ["--allow-tcp-port", String(port)]),
          ]),
    ];
  }

  /**
   * Block until sealantd answers `health` through the runner's control socket. The runner binds
   * the socket before the guest boots, so a connection alone proves nothing: only an answer from
   * the daemon does. Fails at once when the runner exits.
   */
  async #awaitReady(name: string, scope: string): Promise<void> {
    const target = {
      kind: "unix-socket" as const,
      socketPath: this.#endpoint(scope).slice("unix://".length),
    };
    const deadline = Date.now() + this.#readinessTimeoutMs;
    for (;;) {
      try {
        await withTimeout(this.#control.health(target), HEALTH_ATTEMPT_MS, "the health probe");
        return;
      } catch {
        // Not up yet; the runner's state decides whether to wait.
      }
      const state = await this.#containerState(name).catch(() => undefined);
      if (state !== undefined && (state.kind === "absent" || !state.running)) {
        throw new HostVmRunnerEnded(
          name,
          state.kind === "absent" ? undefined : state.exitCode,
          await this.#logs(name),
        );
      }
      if (Date.now() > deadline) {
        const logs = await this.#logs(name);
        throw createAdapterError(
          "adapter-unavailable",
          `Host VM '${name}' did not answer on its control socket within ${String(this.#readinessTimeoutMs)} ms.${logs === undefined ? "" : ` Logs:\n${logs}`}`,
        );
      }
      await delay(READINESS_POLL_MS);
    }
  }

  public async launch(
    input: RuntimeAdapterLaunchInput,
    hooks?: RuntimeAdapterLaunchHooks,
  ): Promise<RuntimeAdapterLaunchResult> {
    // Before the first await: the launching fiber is still current (`withLaunchTelemetry`).
    const parsed = withLaunchTelemetry(
      parseRuntimeAdapterLaunchInput(input),
      this.#daemonTelemetry,
    );
    const support = this.supports({ blueprint: parsed.blueprint });
    if (!support.supported) throw createAdapterError(support.reason, support.message);
    const egressProxy = this.#egressProxy;
    const runId = parsed.runId;
    if (egressProxy === undefined || runId === undefined) {
      throw createAdapterError(
        "adapter-unavailable",
        "A host VM launch needs its run id: the run's row records the VM's disks.",
      );
    }
    const name = this.containerName(runId);
    // Where the runner binds control.sock and the caller serves capture.sock and session.sock.
    const scope = parsed.controlScope ?? name;
    const identity = this.#identity(name, scope);
    const holdsCaptures = launchHoldsCaptures(parsed.blueprint);
    const bootEnvPath = joinPath(this.#storage.controlPath(scope), LAUNCH_FILE.normal);
    let executor: { readonly ended: boolean } | undefined;
    // What THIS launch made, and so may remove when it fails. Anything it found, adopted, or whose
    // creation it cannot vouch for (a failed inspection, a `docker run` whose outcome is unclear)
    // is left for the reconcilers and the recovery sweep.
    const owned = { container: false, proxy: false, disk: false };
    try {
      const existing = await this.#containerState(name);
      const adopt = existing.kind === "present" && existing.running;
      if (existing.kind === "present" && !existing.running) {
        // An ended runner of this run: its data disk may hold the newest work.
        executor = { ended: true };
        if (holdsCaptures) {
          throw createAdapterError(
            "adapter-unavailable",
            `Host VM '${name}' of this run already exists and has ended; its data disk is kept for recovery.`,
          );
        }
        await this.#run("docker", ["rm", "-f", name]);
        executor = undefined;
      } else if (
        existing.kind === "absent" &&
        holdsCaptures &&
        (await this.#storage.dataDiskExists(name))
      ) {
        // The runner was pruned after it ran: its data disk is the only copy of its work.
        executor = { ended: true };
        throw createAdapterError(
          "adapter-unavailable",
          `Host VM '${name}' of this run left a data disk and no container; the disk is kept for recovery.`,
        );
      }

      if (!adopt) {
        await this.#storage.assertLaunchHeadroom();
        const digest = parsed.publication.image.digest;
        const base = await this.#storage.ensureBaseImage({
          digest,
          reference: parsed.publication.image.digestReference,
        });
        const prepared = await this.#storage.prepareExecutor({
          containerName: name,
          baseImageDigest: digest,
          controlScope: scope,
        });
        owned.disk = prepared.created;
        // On record before the container exists: from here a prune cannot lose the disk's owner.
        const flags = hostVmEgressFlags(parsed.blueprint.networkPolicy);
        await this.#records.record({
          runId,
          dataDiskPath: prepared.dataDiskPath,
          baseImageDigest: digest,
          runnerEgress: { mode: flags.egress, allowTcpPorts: flags.allowTcpPorts },
        });
        // The proxy comes up on the workspace's isolated network and takes its first policy
        // before the runner exists, so the VM never has a moment without it (§7.1).
        const launch = parsed.egressProxy;
        if (launch === undefined) {
          throw createAdapterError(
            "adapter-unavailable",
            "A host VM boots only behind its egress proxy, and this launch carries no executor CA or policy for it.",
          );
        }
        await this.#assertIsolatedGatewaySupport(egressProxy);
        owned.proxy = (await egressProxy.proxies.state(name)) === undefined;
        const host = await egressProxy.hostPolicy();
        const proxy = await egressProxy.proxies.launchProxy({
          workspaceContainer: name,
          launch,
          operatorAllowedPrivateCidrs: host.operatorAllowedPrivateCidrs,
          hostPublicIps: host.hostPublicIps,
        });
        const egress: HostVmEgressAttachment = {
          network: proxy.networks.isolated.name,
          proxyIp: proxy.networks.proxyIp,
          ...flags,
        };
        const dockerService = parsed.blueprint.tooling.services?.docker?.enabled === true;
        const launchFiles = await this.#launchFiles(parsed, dockerService);
        await this.#stage(scope, base, {
          launch: launchFiles.normal,
          recoveryTemplate: launchFiles.recoveryTemplate,
          // The guest trusts the proxy's inspecting hosts through it (its combined CA bundle).
          executorCaPem: proxy.caCertPem,
        });
        const memory = hostVmMemory(await this.#limits(), dockerService);
        try {
          await this.#run(
            "docker",
            this.#runArgs({
              name,
              controlScope: scope,
              mode: "normal",
              baseImageDigest: digest,
              guestMib: memory.guestMib,
              containerBytes: memory.containerBytes,
              runId,
              egress,
            }),
          );
          owned.container = true;
        } catch (error) {
          // A concurrent launch of the same run created it first: adopt it when it runs. Its
          // proxy is that launch's too.
          const raced = await this.#containerState(name).catch(() => undefined);
          // Created and never started (no /dev/kvm, a refused device): this launch's own, and
          // removed with its failure, or every redelivery would find an "ended" runner to keep.
          if (raced?.kind === "present" && raced.status === "created") owned.container = true;
          if (raced?.kind !== "present" || !raced.running) throw error;
          owned.proxy = false;
          owned.disk = false;
        }
      }
      executor = { ended: false };
      await reportStartedLaunch(hooks, identity);
      await this.#awaitReady(name, scope);
      // The guest has read its secrets: they are not left on disk.
      await rm(bootEnvPath, { force: true });
      const target = {
        kind: "unix-socket" as const,
        socketPath: this.#endpoint(scope).slice("unix://".length),
      };
      return await completeReadyLaunch({
        blueprint: parsed.blueprint,
        identity,
        hooks,
        steps: async () => {
          const credentialFiles = parsed.credentialFiles ?? [];
          if (credentialFiles.length > 0) {
            await this.#control.writeCredentialFiles(target, credentialFiles);
          }
          return parseRuntimeAdapterLaunchResult({
            adapter: this.id,
            resourceId: name,
            reference: name,
            status: "ready",
            endpoint: identity.endpoint,
            controlScope: scope,
          });
        },
      });
    } catch (error) {
      // Whatever failed, the launch's secrets never stay on disk: a runner that boots later reads
      // none, and a kept executor is recovered from the secret-free template.
      await rm(bootEnvPath, { force: true }).catch(() => undefined);
      return failLaunch({
        blueprint: parsed.blueprint,
        identity: executor === undefined ? undefined : identity,
        runtime: executor?.ended === true ? "exited" : "running",
        error,
        cleanup: async () => {
          if (owned.container) await this.#run("docker", ["rm", "-f", name]).catch(() => undefined);
          if (owned.proxy) await egressProxy.proxies.remove(name).catch(() => undefined);
          // The caller's sockets stay bound for the next launch of this executor.
          if (owned.disk) {
            await this.#storage
              .removeExecutor(name, { controlScope: scope, keepCallerSockets: true })
              .catch(() => undefined);
          }
        },
      });
    }
  }

  /**
   * The normal boot's launch file and the recovery's template. The template carries only what a
   * recovery boot reads (the capture source, the workspace layout, and the lifecycle and harness
   * keys sealantd validates even though it runs none of them): no clone auth, no platform or
   * credential env, no secret env. `recover` adds the capture token when it stages it.
   */
  async #launchFiles(
    parsed: RuntimeAdapterLaunchInput,
    dockerService: boolean,
  ): Promise<{
    readonly normal: HostVmStagedLaunch;
    readonly recoveryTemplate: HostVmStagedLaunch;
  }> {
    const stopGraceMs = this.#shutdownGraceSeconds * 1000;
    // The telemetry rides the staged file's own `telemetry`, not the boot env: the runner reads it
    // for its own launch span and hands the guest the rest.
    const { telemetry, ...untraced } = parsed;
    const bootEnv = nativeBootEnv(untraced, { secretEnvFile: false, dotfiles: false, stopGraceMs });
    if (dockerService) bootEnv.DOCKER_HOST = GUEST_DOCKER_HOST;
    const {
      workspaceCloneAuth: _cloneAuth,
      platformEnv: _platformEnv,
      credentialEnv: _credentialEnv,
      ...plain
    } = untraced;
    const recoveryBootEnv = nativeBootEnv(plain, {
      secretEnvFile: false,
      dotfiles: false,
      stopGraceMs,
    });
    const dotfiles = await readDotfilesArchive(parsed.dotfilesArchiveDir);
    const { traceparent: _traceparent, tracestate: _tracestate, ...reporting } = telemetry ?? {};
    const recoveryTelemetry = Object.keys(reporting).length === 0 ? undefined : reporting;
    return {
      normal: {
        mode: "normal",
        bootEnv,
        secretEnv: parsed.secretEnv ?? (await readSecretEnv(parsed.secretEnvDir)),
        dockerd: dockerService,
        ...(dotfiles === undefined ? {} : { dotfilesArchive: dotfiles }),
        ...(telemetry === undefined ? {} : { telemetry }),
      },
      recoveryTemplate: {
        mode: "recover",
        bootEnv: recoveryBootEnv,
        secretEnv: {},
        dockerd: false,
        // A recovery is a trace of its own: it keeps where to report, never the launch's span.
        ...(recoveryTelemetry === undefined ? {} : { telemetry: recoveryTelemetry }),
      },
    };
  }

  /**
   * What the runner container is now. A container that is gone while its data disk is kept was
   * pruned (or removed by hand) after it ended: that is an ENDED executor whose disk survives,
   * never a missing one, so every path that weighs it keeps the disk and asks for its recovery.
   */
  public async inspect(input: RuntimeAdapterInspectInput): Promise<RuntimeAdapterInspectResult> {
    const name = input.resourceId;
    const state = await this.#containerState(name);
    if (state.kind === "present" && state.status !== "removing") {
      if (state.running) return { state: "running", platformState: state.status };
      const logs = await this.#logs(name);
      return {
        state: "exited",
        exitCode: state.exitCode,
        detail: `status: ${state.status}, exitCode: ${String(state.exitCode)}${
          state.error.length > 0 ? `, error: ${state.error}` : ""
        }${logs === undefined ? "" : `\nLogs:\n${logs}`}`,
      };
    }
    if (await this.#storage.dataDiskExists(name)) {
      return {
        state: "exited",
        detail: `The runner container '${name}' is gone, and its data disk is kept at ${this.#storage.dataDiskPath(name)}.`,
        platformEnded: false,
      };
    }
    return { state: "missing" };
  }

  /**
   * Recover a retained executor on its own data disk: a fresh runner in `--mode recover` (no
   * network, no proxy, no session channel), whether its stopped container is still there or was
   * pruned. The recovery boot gets the capture token (`input.secretEnv`) in `recovery-env.json`.
   */
  public async recover(input: RuntimeAdapterRecoverInput): Promise<RuntimeAdapterRecoverResult> {
    const name = input.resourceId;
    const state = await this.#containerState(name);
    if (state.kind === "present" && state.running) return { outcome: "running" };
    if (!(await this.#storage.dataDiskExists(name))) {
      return state.kind === "absent"
        ? { outcome: "missing" }
        : {
            outcome: "unsupported",
            detail: `Host VM '${name}' has no data disk at ${this.#storage.dataDiskPath(name)}; there is nothing to boot a recovery on.`,
          };
    }
    const record = await this.#diskRecord(name, input.runId);
    if (record === undefined) {
      return {
        outcome: "unsupported",
        detail: `Nothing records which base image host VM '${name}' booted from, so its data disk cannot be booted again. Its disk is kept at ${this.#storage.dataDiskPath(name)}.`,
      };
    }
    const base = this.#storage.baseImage(record.baseImageDigest);
    // The scope it was launched in: the caller binds capture.sock there (and no session.sock).
    const scope = await this.#scopeOf(name);
    const template = await this.#recoveryTemplate(name, scope);
    await this.#egressProxy?.proxies.park(name).catch(() => false);
    if (state.kind === "present") {
      // Stopped: it was made for a normal boot, and its mode is fixed at `docker run`.
      await this.#run("docker", ["rm", "-f", name]);
    }
    const memory = hostVmMemory(await this.#limits(), false);
    try {
      await this.#stage(scope, base, {
        launch: { ...template, mode: "recover", secretEnv: input.secretEnv ?? {}, dockerd: false },
      });
      await this.#run(
        "docker",
        this.#runArgs({
          name,
          controlScope: scope,
          mode: "recover",
          baseImageDigest: record.baseImageDigest,
          guestMib: memory.guestMib,
          containerBytes: memory.containerBytes,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        }),
      );
      await this.#awaitReady(name, scope);
    } catch (error) {
      if (error instanceof HostVmRunnerEnded && error.exitCode === SEALANTD_EXIT_NOTHING_TO_SAVE) {
        // The runner exits 76 only on the guest's synced "nothing to save" and a clean VMM exit.
        return { outcome: "nothing-to-save", detail: nothingToSaveDetail(error.logs) };
      }
      throw error;
    } finally {
      // Booted, ended or never started: the capture token goes, and the template comes back
      // without it for the next attempt.
      await this.#stage(scope, base, { recoveryTemplate: template }).catch(async () => {
        await rm(joinPath(this.#storage.controlPath(scope), LAUNCH_FILE.recover), {
          force: true,
        }).catch(() => undefined);
      });
    }
    return { outcome: "restarted" };
  }

  async #diskRecord(
    name: string,
    runId: string | undefined,
  ): Promise<HostVmDiskRecord | undefined> {
    const recorded = runId === undefined ? undefined : await this.#records.load(runId);
    if (recorded !== undefined) return recorded;
    // The marker the disk was made with: for a caller that names no run.
    const digest = await this.#storage.markedBaseImageDigest(name);
    return digest === undefined
      ? undefined
      : { dataDiskPath: this.#storage.dataDiskPath(name), baseImageDigest: digest };
  }

  async #recoveryTemplate(name: string, scope: string): Promise<HostVmStagedLaunch> {
    const path = joinPath(this.#storage.controlPath(scope), LAUNCH_FILE.recover);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        throw createAdapterError(
          "adapter-unavailable",
          `Host VM '${name}' has no recovery environment at ${path}; its launch staged one, and it is gone.`,
        );
      }
      throw error;
    }
    const parsed = stagedLaunchSchema.parse(JSON.parse(text));
    return { ...parsed, mode: "recover", secretEnv: {}, dockerd: false };
  }

  /**
   * A retained executor that ended has no use for its egress proxy while it waits: stop
   * `<name>-proxy`, keep the data disk and the network. Idempotent.
   */
  public async parkRetained(input: RuntimeAdapterParkInput): Promise<RuntimeAdapterParkResult> {
    const state = await this.#containerState(input.resourceId).catch(() => undefined);
    if (state === undefined || (state.kind === "present" && state.running)) return { stopped: [] };
    const stopped = (await this.#egressProxy?.proxies.park(input.resourceId)) ?? false;
    return { stopped: stopped ? [`${input.resourceId}-proxy`] : [] };
  }

  /** The executor a launch of `runId` made: its runner container, or its data disk alone. */
  public async locate(input: {
    readonly runId: string;
  }): Promise<RuntimeLaunchIdentity | undefined> {
    const name = this.containerName(input.runId);
    const state = await this.#containerState(name);
    if (state.kind === "present" || (await this.#storage.dataDiskExists(name))) {
      return this.#identity(name, await this.#scopeOf(name));
    }
    return undefined;
  }

  /**
   * `end` stops the runner (`docker stop -t`, longer than the guest's shutdown grace) and keeps
   * the container and its data disk; `remove` takes the container, its proxy, its data disk and
   * its control directory. Absent, both.
   */
  public async stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult> {
    const parsed = parseRuntimeAdapterStopInput(input);
    const name = parsed.resourceId;
    if (parsed.phase === "end") return this.#end(parsed);
    if (parsed.fence !== true && parsed.phase !== "remove") await this.#plannedStop(name);
    const state = await this.#containerState(name);
    if (state.kind === "present") {
      try {
        await this.#run("docker", ["rm", "-f", name]);
      } catch (error) {
        if (!isNoSuchContainerError(error)) {
          const failure = createAdapterError(
            "adapter-unavailable",
            `Failed to remove host VM '${name}': ${error instanceof Error ? error.message : String(error)}`,
          );
          throw isDaemonErrorResponse(error) ? removalRefused(failure) : failure;
        }
      }
    }
    const disk = await this.#storage.dataDiskExists(name);
    // Read before the disk goes: the marker beside it names the scope.
    const scope = disk ? await this.#scopeOf(name) : name;
    // Its proxy, its networks and their subnets go with it.
    await this.#egressProxy?.proxies.remove(name);
    // The data disk and the control scope (its staged files and sockets) go together.
    await this.#storage.removeExecutor(name, { controlScope: scope });
    return parseRuntimeAdapterStopResult({
      adapter: this.id,
      resourceId: name,
      outcome: state.kind === "absent" && !disk ? "not-found" : "stopped",
    });
  }

  async #plannedStop(name: string): Promise<void> {
    await this.#run("docker", ["stop", "-t", String(this.#stopTimeoutSeconds), name]).catch(
      () => undefined,
    );
  }

  async #end(parsed: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult> {
    const name = parsed.resourceId;
    if (parsed.fence !== true) await this.#plannedStop(name);
    const killFailure = await this.#run("docker", ["kill", name]).then(
      () => undefined,
      (error: unknown) => error,
    );
    const state = await this.#containerState(name);
    if (state.kind === "present" && state.running) {
      const failure = createAdapterError(
        "adapter-unavailable",
        `Host VM '${name}' is still running after it was asked to end (status: ${state.status}).`,
      );
      throw killFailure !== undefined && isDaemonErrorResponse(killFailure)
        ? removalRefused(failure)
        : failure;
    }
    const gone = state.kind === "absent" && !(await this.#storage.dataDiskExists(name));
    return parseRuntimeAdapterStopResult({
      adapter: this.id,
      resourceId: name,
      outcome: gone ? "not-found" : "stopped",
    });
  }

  /** Runner exits as Docker announces them (`die` events of this adapter's containers). */
  public watchExits(input: RuntimeAdapterExitWatchInput): RuntimeAdapterExitWatch {
    const opener = this.#eventStreamOpener;
    if (opener === undefined) return { close: () => undefined };
    const prefix = `${this.#prefix}-`;
    const wanted = input.resourceIds === undefined ? undefined : new Set(input.resourceIds);
    let closed = false;
    let stream: DockerEventStream | undefined;
    let timer: NodeJS.Timeout | undefined;
    let backoff = EVENT_STREAM_RECONNECT_MIN_MS;
    const open = (): void => {
      if (closed) return;
      stream = opener({
        args: [
          "events",
          "--filter",
          "type=container",
          "--filter",
          "event=die",
          "--filter",
          `label=${HOST_VM_LABEL}`,
          "--format",
          "{{json .}}",
        ],
        onLine: (line) => {
          backoff = EVENT_STREAM_RECONNECT_MIN_MS;
          const event = parseRunnerDie(line, prefix);
          if (event === undefined || (wanted !== undefined && !wanted.has(event.name))) return;
          input.onExit({
            resourceId: event.name,
            result:
              event.exitCode === undefined
                ? { state: "exited" }
                : { state: "exited", exitCode: event.exitCode },
          });
        },
        onEnd: (error) => {
          stream = undefined;
          if (closed) return;
          if (error !== undefined) input.onError?.(error);
          timer = setTimeout(() => {
            timer = undefined;
            open();
          }, backoff);
          timer.unref();
          backoff = Math.min(backoff * 2, EVENT_STREAM_RECONNECT_MAX_MS);
        },
      });
    };
    open();
    return {
      close: () => {
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        stream?.kill();
        stream = undefined;
      },
    };
  }
}

/** The runner exited before its daemon answered. */
export class HostVmRunnerEnded extends Error {
  public override readonly name = "HostVmRunnerEnded";
  public readonly code = "adapter-unavailable";

  public constructor(
    public readonly containerName: string,
    public readonly exitCode: number | undefined,
    public readonly logs: string | undefined,
  ) {
    super(
      `Host VM '${containerName}' ${
        exitCode === undefined ? "is gone" : `exited with ${String(exitCode)}`
      } before its daemon answered.${logs === undefined ? "" : ` Logs:\n${logs}`}`,
    );
  }
}

const dieEventSchema = z.object({
  Action: z.literal("die"),
  Actor: z.object({
    Attributes: z.object({ name: z.string(), exitCode: z.string().optional() }).loose(),
  }),
});

const parseRunnerDie = (
  line: string,
  prefix: string,
): { readonly name: string; readonly exitCode?: number } | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = dieEventSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { name, exitCode } = parsed.data.Actor.Attributes;
  if (!name.startsWith(prefix)) return undefined;
  return exitCode !== undefined && /^\d+$/.test(exitCode)
    ? { name, exitCode: Number(exitCode) }
    : { name };
};

/** The worker-staged secret env (`<dir>/env.json`, a flat object), or none. */
const readSecretEnv = async (directory: string | undefined): Promise<Record<string, string>> => {
  if (directory === undefined) return {};
  const text = await readFile(joinPath(directory, "env.json"), "utf8");
  return z.record(z.string(), z.string()).parse(JSON.parse(text));
};

/** The worker-staged dotfiles archives (`manifest.json` + `*.tar.gz`), inline, by file name. */
const readDotfilesArchive = async (
  directory: string | undefined,
): Promise<{ readonly files: Record<string, string> } | undefined> => {
  if (directory === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    files[entry.name] = (await readFile(joinPath(directory, entry.name))).toString("base64");
  }
  return { files };
};
