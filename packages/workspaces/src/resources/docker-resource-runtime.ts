/**
 * Resource instances on a Docker host: the shell that runs what `docker-resource-argv.ts` builds.
 * Each method reads what Docker holds and applies the difference, so running it twice finds
 * nothing left to do, and an API call and the reconciler's tick racing converge on the same names.
 *
 * Volumes outlive everything here: no method runs `docker rm -v`, `docker volume rm` or a prune.
 */
import { spawn } from "node:child_process";

import type { ResourceInstanceState, ResourceInstanceVolume } from "@sealant/api-contracts";
import type { CredentialCipherService } from "@sealant/credentials";
import type { ResourceInstanceRecord, ResourceNetworkKind } from "@sealant/db";

import { sortCidrs, type Cidr } from "../runtime/cidr.js";
import { EGRESS_PROXY_BACKED_LABEL } from "../runtime/docker-egress-proxy.js";
import {
  attachedNetworks,
  carveProhibitRouteScript,
  guardsPrivateRange,
  hostAddressesArgv,
  hostAddressesInSubnets,
  ipamConfig,
  prohibitRoutes,
  prohibitRouteScript,
  routeTableArgv,
  workspaceEgressNetworkName,
  type AttachedNetworks,
  type IpamConfig,
} from "../runtime/docker-egress.js";
import {
  cloudMetadataGuardArgv,
  createDockerCommandRunner,
  DEFAULT_NETWORK_GUARD_IMAGE,
  networkGuardArgv,
  type DockerCommandRunner,
} from "../runtime/docker-runtime-adapter.js";
import { egressProxyName } from "../runtime/egress-proxy-orchestrator.js";
import { callerInstanceName, type ResourceCallerConfig } from "./caller-config.js";
import { DockerCallerRuntime } from "./docker-caller-runtime.js";
import {
  connectArgv,
  coverImageVolumes,
  disconnectArgv,
  egressNetworkName,
  execArgv,
  imageVolumesArgv,
  instanceContainerName,
  instanceRunArgv,
  instanceVolumeName,
  networkCreateArgv,
  parseImageVolumes,
  probeArgv,
  reachNetworkName,
  RESOURCE_LABELS,
  RESOURCE_STOP_TIMEOUT_SECONDS,
  volumeCreateArgv,
} from "./docker-resource-argv.js";
import type { ReachAttachment } from "./reach.js";

/** The networks resource instances and their callers use; a workspace's own egress is not one. */
export type ResourceInstanceNetworkKind = Exclude<ResourceNetworkKind, "workspace">;

/** sealant's subnet pools (`ResourceInstanceRepo.allocateNetwork`), as the runtime needs them. */
export interface ResourceSubnets {
  /** The network's subnet, the one it already holds or a new one. Throws when the pool is full. */
  readonly allocate: (input: {
    readonly name: string;
    readonly kind: ResourceInstanceNetworkKind;
    readonly owner: string;
  }) => Promise<string>;
  readonly release: (name: string) => Promise<void>;
}

/** The largest stdout or stderr an exec answers: the tail, when there is more. */
export const RESOURCE_EXEC_OUTPUT_LIMIT = 1024 * 1024;

export interface ResourceExecCommand {
  readonly argv: ReadonlyArray<string>;
  readonly user: string | null;
  readonly timeoutMs: number;
}

export interface ResourceExecResult {
  /** Null when the command was killed at its timeout. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Either output was longer than the limit, and only its tail is here. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ResourceUpResult {
  readonly state: ResourceInstanceState;
  /** Every volume the container mounts, once it was created. */
  readonly volumes?: ReadonlyArray<ResourceInstanceVolume>;
  /** When the ready check answered. */
  readonly startedAt?: Date;
}

export interface ArchivedVolume {
  readonly name: string;
  readonly dockerName: string;
  /** Measured at archive; null when it could not be. */
  readonly bytes: number | null;
}

export interface ObservedContainer {
  readonly running: boolean;
  readonly exitCode: number | null;
}

export interface ResourceRuntime {
  /** Fresh stopped/provider-policy check before fencing an irreversible caller purge. */
  readonly checkPurge?: (instance: ResourceInstanceRecord) => Promise<void>;
  /** Delete caller resources and retained data, confirming absence. Never stops a running workload. */
  readonly purge?: (instance: ResourceInstanceRecord) => Promise<void>;
  /** False when this provider must leave legacy workspace-instance records untouched. */
  readonly workspaceReach?: boolean;
  /** Provider configuration checks performed before writing desired state. */
  readonly validateCaller?: (spec: ResourceInstanceRecord["spec"]) => void;
  readonly endpoint?: (instance: ResourceInstanceRecord) => {
    readonly host: string;
    readonly port: number;
    readonly callbackHost: string;
  };
  readonly health?: (instance: ResourceInstanceRecord) => Promise<ResourceInstanceState>;
  readonly backup?: (
    instance: ResourceInstanceRecord,
    volume: string,
  ) => Promise<ReadableStream<Uint8Array>>;
  /**
   * Converge one instance to running and answered: its egress network, its volumes, its container
   * (a changed spec replaces the container and keeps every volume), the metadata guard on every
   * start, its reach attachments, then the ready check. A start that cannot finish answers
   * `failed` with what went wrong, never throws for it.
   */
  readonly up: (
    instance: ResourceInstanceRecord,
    attachments: ReadonlyArray<ReachAttachment>,
  ) => Promise<ResourceUpResult>;
  /** Graceful stop. The container, its volumes and attachments stay. A missing one is stopped. */
  readonly stop: (instance: ResourceInstanceRecord) => Promise<void>;
  /** Stop, remove the container (never its volumes) and its egress network; measure each volume. */
  readonly archive: (instance: ResourceInstanceRecord) => Promise<ReadonlyArray<ArchivedVolume>>;
  /** Run a command in the running instance: stdin streams in, stdout and stderr come back as tails. */
  readonly exec: (
    instance: ResourceInstanceRecord,
    command: ResourceExecCommand,
    stdin: AsyncIterable<Uint8Array> | null,
  ) => Promise<ResourceExecResult>;
  /**
   * The executor's reach network, created on sealant's subnet, holding exactly the executor and
   * each instance it reaches: an instance the attachments leave out is disconnected.
   */
  readonly attachExecutor: (
    executor: string,
    attachments: ReadonlyArray<ReachAttachment>,
  ) => Promise<void>;
  /** Empty and remove the executor's reach network, and release its subnet. */
  readonly detachExecutor: (executor: string) => Promise<void>;
  /**
   * Make Docker hold exactly `desired` on Sealant's reach networks: each live executor's network
   * exists with what it should reach, and the network of any other executor Sealant knows of goes.
   */
  readonly converge: (input: {
    readonly desired: ReadonlyArray<ReachAttachment>;
    readonly liveExecutors: ReadonlyArray<string>;
    readonly knownExecutors: ReadonlyArray<string>;
  }) => Promise<void>;
  /** Every resource container Docker has, by instance id. */
  readonly observe: () => Promise<ReadonlyMap<string, ObservedContainer>>;
}

export interface DockerResourceRuntimeOptions {
  readonly callers?: ResourceCallerConfig;
  readonly cipher?: CredentialCipherService;
  readonly callerGuardImage?: string;
  readonly subnets: ResourceSubnets;
  readonly dockerSocketPath?: string;
  readonly guardImage?: string;
  /** How long `up` waits for the ready check (120 s). */
  readonly readyTimeoutMs?: number;
  readonly commandRunner?: DockerCommandRunner;
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1000;
const PROBE_TIMEOUT_MS = 10_000;
const GUARD_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const MEASURE_TIMEOUT_MS = 5 * 60_000;

/** A start that could not finish, and why. */
const failed = (message: string): ResourceUpResult => ({
  state: { kind: "failed", at: new Date().toISOString(), message },
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`;
};

/** Docker's own words for an object that is not there. */
const isMissing = (error: unknown) =>
  /no such (container|object|network|volume|image)|network \S+ not found/i.test(errorText(error));
/** An engine that does not know `gateway_mode_ipv4=isolated` (before Docker 28). */
const isGatewayModeRefused = (error: unknown) =>
  /gateway_mode_ipv4|gateway mode/i.test(errorText(error));

/** Docker's own words for an object that is already there. */
const isPresent = (error: unknown) => /already exists|is already in use/i.test(errorText(error));
const isNotConnected = (error: unknown) => /is not connected/i.test(errorText(error));
/** Docker refusing an address that a route in the container's namespace overlaps. */
const isRouteConflict = (error: unknown) => /conflicts with existing route/i.test(errorText(error));

const ipv4 = (blocks: ReadonlyArray<Cidr>) => blocks.filter((block) => block.family === 4);

/** The first line of a Docker failure, for a state's message or a reply; never an argv. */
export const dockerFailureReason = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  if (!("stderr" in error)) return (error.message.split("\n")[0] ?? "").slice(0, 500);
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  if (stderr.length === 0) {
    // execFile's own message starts with the whole command line: never repeat it.
    const killed = "killed" in error && error.killed === true;
    return killed ? "the docker command did not finish in time" : "the docker command failed";
  }
  const line = stderr.split("\n")[0] ?? "";
  return line.replace(/^Error response from daemon:\s*/i, "").slice(0, 500);
};

/** The last `limit` bytes of a stream, and whether anything before them was dropped. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  public truncated = false;
  public constructor(private readonly limit: number) {}
  public push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()?.length ?? 0;
      this.truncated = true;
    }
  }
  public text(): string {
    const all = Buffer.concat(this.chunks);
    if (all.length > this.limit) this.truncated = true;
    return all.subarray(Math.max(0, all.length - this.limit)).toString("utf8");
  }
}

export class DockerResourceRuntime implements ResourceRuntime {
  private readonly docker: DockerCommandRunner;
  private readonly caller: DockerCallerRuntime;
  private readonly dockerSocketPath: string;
  private readonly guardImage: string;
  private readonly readyTimeoutMs: number;
  /** Whether internal networks are still made with no host gateway (until the engine refuses). */
  private isolatedGateways = true;
  private readonly subnets: ResourceSubnets;

  public constructor(options: DockerResourceRuntimeOptions) {
    this.caller = new DockerCallerRuntime({
      subnets: options.subnets,
      callers: options.callers ?? [],
      ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
      ...(options.dockerSocketPath === undefined
        ? {}
        : { dockerSocketPath: options.dockerSocketPath }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
      ...(options.callerGuardImage === undefined ? {} : { guardImage: options.callerGuardImage }),
    });
    this.dockerSocketPath = options.dockerSocketPath ?? "/var/run/docker.sock";
    this.docker = options.commandRunner ?? createDockerCommandRunner(this.dockerSocketPath);
    this.guardImage = options.guardImage ?? DEFAULT_NETWORK_GUARD_IMAGE;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.subnets = options.subnets;
  }

  private run(args: ReadonlyArray<string>, timeoutMs?: number) {
    return this.docker("docker", [...args], timeoutMs === undefined ? undefined : { timeoutMs });
  }

  /** Run, and treat `ok(error)` as success. */
  private async runTolerating(
    args: ReadonlyArray<string>,
    ok: (error: unknown) => boolean,
  ): Promise<void> {
    await this.run(args).catch((error: unknown) => {
      if (!ok(error)) throw error;
    });
  }

  private async networkExists(name: string): Promise<boolean> {
    try {
      await this.run(["network", "inspect", "--format", "{{.Id}}", name]);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * The network on sealant's subnet: created when missing, its subnet held in sealant's table. An
   * internal network is made with no host gateway (`networkCreateArgv`'s `isolatedGateway`) where
   * the engine accepts it; one that refuses the option gets a plain internal network, and is not
   * asked again.
   */
  private async ensureNetwork(name: string, kind: ResourceInstanceNetworkKind, owner: string) {
    if (await this.networkExists(name)) return;
    const subnet = await this.subnets.allocate({ name, kind, owner });
    if (kind !== "egress" && this.isolatedGateways) {
      try {
        await this.runTolerating(
          networkCreateArgv(name, kind, subnet, { isolatedGateway: true }),
          isPresent,
        );
        return;
      } catch (error) {
        if (!isGatewayModeRefused(error)) throw error;
        this.isolatedGateways = false;
      }
    }
    await this.runTolerating(networkCreateArgv(name, kind, subnet), isPresent);
  }

  private async networkContainers(name: string): Promise<ReadonlyArray<string>> {
    const result = await this.run([
      "network",
      "inspect",
      "--format",
      "{{range .Containers}}{{.Name}}\n{{end}}",
      name,
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Disconnect every member, remove the network and release its subnet. `beforeEmpty` runs on the
   * members first, while the network (and so its subnet) still exists: a failure there leaves the
   * network for the next attempt, which finds the same members.
   */
  private async removeNetwork(
    name: string,
    beforeEmpty?: (members: ReadonlyArray<string>) => Promise<void>,
  ): Promise<void> {
    if (await this.networkExists(name)) {
      const members = await this.networkContainers(name);
      await beforeEmpty?.(members);
      for (const container of members) {
        await this.runTolerating(
          disconnectArgv(name, container),
          (error) => isMissing(error) || isNotConnected(error),
        );
      }
      await this.runTolerating(["network", "rm", name], isMissing);
    }
    await this.subnets.release(name);
  }

  private async inspectContainer(
    name: string,
  ): Promise<
    | { readonly running: boolean; readonly exitCode: number; readonly specDigest: string }
    | undefined
  > {
    try {
      const result = await this.run([
        "container",
        "inspect",
        "--format",
        `{{.State.Running}}\t{{.State.ExitCode}}\t{{index .Config.Labels "${RESOURCE_LABELS.specDigest}"}}`,
        name,
      ]);
      const [running, exitCode, specDigest] = result.stdout.trim().split("\t");
      return {
        running: running === "true",
        exitCode: Number(exitCode),
        specDigest: specDigest ?? "",
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** The image's declared volumes, pulling it first when the host lacks it. */
  private async imageVolumes(image: string): Promise<ReadonlyArray<string>> {
    try {
      return parseImageVolumes((await this.run(imageVolumesArgv(image))).stdout);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.run(["pull", "-q", image], PULL_TIMEOUT_MS);
    return parseImageVolumes((await this.run(imageVolumesArgv(image))).stdout);
  }

  /** A container's state and networks; `undefined` when Docker has no such container. */
  private async inspectMember(
    name: string,
  ): Promise<{ readonly running: boolean; readonly networks: AttachedNetworks } | undefined> {
    try {
      const result = await this.run([
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}\t{{json .NetworkSettings.Networks}}",
        name,
      ]);
      const [running = "", networks = ""] = result.stdout.trim().split("\t");
      return { running: running === "true", networks: attachedNetworks(networks) };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /**
   * The executor's reach network exists with the executor on it. A member already on it costs no
   * guard container.
   *
   * A workspace under per-workspace egress (on its own `-egress` network) has a `prohibit` route
   * over the whole reach pool, and Docker refuses to connect it to a network inside that route. It
   * is opened for this network's subnet alone first (`openReach`). Anything else that Docker
   * refuses for the same reason (a guard that ran in between, a guarded container on some other
   * egress network) is opened and connected once more.
   */
  private async ensureReach(executor: string): Promise<void> {
    const network = reachNetworkName(executor);
    // A network for an executor that is not there would only wait to be swept: refuse first.
    const own = await this.inspectMember(executor);
    if (own === undefined) {
      throw new Error(`The executor ${executor} is not on this Docker host.`);
    }
    // A workspace behind its own egress proxy never joins a network that leads past it: its
    // proxy joins the reach network in its place, and the workspace reaches a resource only as
    // its policy grants, through the proxy. No proxy there: refused, never attached directly.
    const proxyBacked = await this.isProxyBacked(executor);
    const member = proxyBacked ? egressProxyName(executor) : executor;
    const current = proxyBacked ? await this.inspectMember(member) : own;
    if (current === undefined) {
      throw new Error(
        `The executor ${executor} runs behind an egress proxy, and its proxy ${member} is not on this Docker host: its resources are not attached.`,
      );
    }
    await this.ensureNetwork(network, "reach", executor);
    if (current.networks.names.includes(network)) return;
    // A stopped workspace (a parked one) has no namespace and no routes yet: it connects as is, and
    // the guard that runs on its next start reads the reach network as one of its own.
    const guarded =
      current.running &&
      !proxyBacked &&
      current.networks.names.includes(workspaceEgressNetworkName(executor));
    // Read once, and only for a member that may be opened.
    let ipam: IpamConfig | undefined;
    const plan = async () => (ipam ??= await this.networkIpam(network));
    let opened = false;
    try {
      if (guarded) {
        opened = true;
        await this.openReach(member, (await plan()).subnets);
      }
      try {
        await this.runTolerating(["network", "connect", network, member], isPresent);
      } catch (error) {
        if (!isRouteConflict(error)) throw error;
        opened = true;
        await this.openReach(member, (await plan()).subnets);
        await this.runTolerating(["network", "connect", network, member], isPresent);
      }
    } catch (error) {
      // Not connected after all: the subnet goes back to refused, as far as that can be done.
      if (opened && ipam !== undefined) {
        await this.run(
          networkGuardArgv(member, this.guardImage, prohibitRouteScript(ipv4(ipam.subnets))),
          GUARD_TIMEOUT_MS,
        ).catch(() => undefined);
      }
      throw error;
    }
    if (opened) await this.refuseReachGateway(member, network, await plan());
  }

  /**
   * Split every `prohibit` route in `member`'s namespace that overlaps a reach network's `subnets`
   * so that subnet, and nothing else, is open (`carveProhibitRouteScript`). The routes are read with the
   * guard image, never the member's own. Throws on anything it cannot read or run, so the member
   * is not connected.
   */
  private async openReach(member: string, subnets: ReadonlyArray<Cidr>): Promise<void> {
    const table = await this.run(routeTableArgv(member, this.guardImage, 4), GUARD_TIMEOUT_MS);
    const script = carveProhibitRouteScript(prohibitRoutes(table.stdout, 4), ipv4(subnets));
    if (script === undefined) return;
    await this.run(networkGuardArgv(member, this.guardImage, script), GUARD_TIMEOUT_MS);
  }

  /**
   * A reach network whose bridge has an address on the host (an engine that refused, or before 26
   * ignored, an isolated gateway) puts the host one hop away (`internal` only takes away the route
   * out), and the carve just opened it with the rest of the subnet. That address is refused again
   * for a member the carve opened. It is read from the host's own interfaces, since no engine
   * before 29 names it in the network's IPAM. An isolated bridge has none, and nothing more runs.
   * One that cannot be read or refused leaves the member disconnected and the subnet refused.
   */
  private async refuseReachGateway(
    member: string,
    network: string,
    ipam: IpamConfig,
  ): Promise<void> {
    const subnets = ipv4(ipam.subnets);
    try {
      const host = await this.run(hostAddressesArgv(this.guardImage), GUARD_TIMEOUT_MS);
      const gateways = sortCidrs([
        ...hostAddressesInSubnets(host.stdout, subnets),
        ...ipv4(ipam.gateways),
      ]);
      if (gateways.length === 0) return;
      await this.run(
        networkGuardArgv(member, this.guardImage, prohibitRouteScript(gateways)),
        GUARD_TIMEOUT_MS,
      );
    } catch (error) {
      await this.runTolerating(
        disconnectArgv(network, member),
        (cause) => isMissing(cause) || isNotConnected(cause),
      );
      await this.run(
        networkGuardArgv(member, this.guardImage, prohibitRouteScript(subnets)),
        GUARD_TIMEOUT_MS,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async networkIpam(network: string): Promise<IpamConfig> {
    const result = await this.run([
      "network",
      "inspect",
      "--format",
      "{{json .IPAM.Config}}",
      network,
    ]);
    return ipamConfig(result.stdout);
  }

  /**
   * Before a reach network goes and its subnet can be handed to another workspace: each running
   * member under per-workspace egress gets `prohibit <subnet>` back, the route its carve took
   * out. Resource instances and an egress proxy never had one. Put in while the member is still
   * connected (it takes the place of the connected route), so no attempt that stops halfway leaves
   * a disconnected workspace without it.
   */
  private async closeReach(
    executor: string,
    network: string,
    members: ReadonlyArray<string>,
  ): Promise<void> {
    const candidates = members.filter(
      (member) => !member.startsWith("sealres-") && member !== egressProxyName(executor),
    );
    if (candidates.length === 0) return;
    const subnets = ipv4((await this.networkIpam(network)).subnets);
    for (const member of candidates) {
      const state = await this.inspectMember(member);
      if (state?.running !== true) continue;
      const guarded =
        state.networks.names.includes(workspaceEgressNetworkName(member)) ||
        (await this.guardsReachRange(member, subnets));
      if (!guarded) continue;
      await this.run(
        networkGuardArgv(member, this.guardImage, prohibitRouteScript(subnets)),
        GUARD_TIMEOUT_MS,
      );
    }
  }

  /** Whether `member`'s routes guard the private range the reach subnets are in. */
  private async guardsReachRange(member: string, subnets: ReadonlyArray<Cidr>): Promise<boolean> {
    const table = await this.run(routeTableArgv(member, this.guardImage, 4), GUARD_TIMEOUT_MS);
    const routes = prohibitRoutes(table.stdout, 4);
    return subnets.some((subnet) => guardsPrivateRange(routes, subnet));
  }

  /** Whether an executor was launched behind its own egress proxy (`EGRESS_PROXY_BACKED_LABEL`). */
  private async isProxyBacked(executor: string): Promise<boolean> {
    const result = await this.run([
      "inspect",
      "--format",
      `{{index .Config.Labels "${EGRESS_PROXY_BACKED_LABEL}"}}`,
      executor,
    ]);
    return result.stdout.trim() === "true";
  }

  private async attach(attachments: ReadonlyArray<ReachAttachment>): Promise<void> {
    for (const executor of new Set(attachments.map((attachment) => attachment.executor))) {
      await this.ensureReach(executor);
    }
    for (const attachment of attachments) {
      await this.runTolerating(connectArgv(attachment), isPresent);
    }
  }

  private async awaitReady(instance: ResourceInstanceRecord, container: string) {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const answered = await this.run(
        probeArgv(container, instance.spec.ready, this.guardImage),
        PROBE_TIMEOUT_MS,
      ).then(
        () => true,
        () => false,
      );
      if (answered) return undefined;
      const state = await this.inspectContainer(container);
      if (state?.running !== true) return "the container exited before its ready check answered";
      if (Date.now() >= deadline) {
        return `the ready check did not answer within ${String(Math.round(this.readyTimeoutMs / 1000))} s`;
      }
      await delay(READY_POLL_MS);
    }
  }

  public async up(
    instance: ResourceInstanceRecord,
    attachments: ReadonlyArray<ReachAttachment>,
  ): Promise<ResourceUpResult> {
    if (instance.spec.reach?.kind === "caller") return this.caller.up(instance);
    const container = instanceContainerName(instance.id);
    let volumes: ReadonlyArray<ResourceInstanceVolume>;
    try {
      // The image first: one that cannot be had leaves nothing else behind.
      const imageVolumes = await this.imageVolumes(instance.spec.image);
      await this.ensureNetwork(egressNetworkName(instance.id), "egress", instance.id);
      volumes = coverImageVolumes(instance.spec.volumes, imageVolumes);
      for (const volume of volumes) await this.run(volumeCreateArgv(instance, volume));
      const existing = await this.inspectContainer(container);
      // Every start is a new container over the same volumes: one that stopped may still name a
      // reach network whose executor went meanwhile, and Docker would refuse to start it. A
      // running one with the same spec is kept.
      if (
        existing !== undefined &&
        (!existing.running || existing.specDigest !== instance.specDigest)
      ) {
        await this.stop(instance);
        await this.runTolerating(["rm", container], isMissing);
      }
      if (existing?.running !== true || existing.specDigest !== instance.specDigest) {
        // A name conflict is a concurrent `up` that created it first: adopt it.
        await this.runTolerating(instanceRunArgv(instance, volumes), isPresent);
      }
      const started = await this.inspectContainer(container);
      if (started?.running !== true) {
        return failed(
          `the container exited as it started (exit code ${String(started?.exitCode ?? "unknown")})`,
        );
      }
    } catch (error) {
      return failed(dockerFailureReason(error));
    }
    try {
      await this.run(cloudMetadataGuardArgv(container, this.guardImage), GUARD_TIMEOUT_MS);
    } catch (error) {
      // Fail closed: an instance never runs without the guard.
      await this.run(["stop", "-t", "10", container]).catch(() => undefined);
      return failed(`the cloud metadata guard could not run: ${dockerFailureReason(error)}`);
    }
    try {
      await this.attach(attachments);
    } catch (error) {
      return {
        ...failed(`it could not join a workspace's network: ${dockerFailureReason(error)}`),
        volumes,
      };
    }
    const notReady = await this.awaitReady(instance, container);
    if (notReady !== undefined) return { ...failed(notReady), volumes };
    const startedAt = new Date();
    return { state: { kind: "running", since: startedAt.toISOString() }, volumes, startedAt };
  }

  public async stop(instance: ResourceInstanceRecord): Promise<void> {
    if (instance.spec.reach?.kind === "caller") return this.caller.stop(instance);
    await this.runTolerating(
      ["stop", "-t", String(RESOURCE_STOP_TIMEOUT_SECONDS), instanceContainerName(instance.id)],
      isMissing,
    );
  }

  public async archive(instance: ResourceInstanceRecord): Promise<ReadonlyArray<ArchivedVolume>> {
    if (instance.spec.reach?.kind === "caller") return this.caller.archive(instance);
    await this.stop(instance);
    await this.runTolerating(["rm", instanceContainerName(instance.id)], isMissing);
    await this.removeNetwork(egressNetworkName(instance.id));
    const volumes = instance.volumes.length > 0 ? instance.volumes : instance.spec.volumes;
    const kept: Array<ArchivedVolume> = [];
    for (const volume of volumes) {
      const dockerName = instanceVolumeName(instance.id, volume.name);
      const exists = await this.run([
        "volume",
        "inspect",
        "--format",
        "{{.Name}}",
        dockerName,
      ]).then(
        () => true,
        () => false,
      );
      if (exists)
        kept.push({ name: volume.name, dockerName, bytes: await this.measure(dockerName) });
    }
    return kept;
  }

  /** `du -sb` of a volume, mounted read-only into the guard image with no network. */
  private async measure(dockerName: string): Promise<number | null> {
    try {
      const result = await this.run(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          // Reads every file whoever owns it (a database's data directory is its user's alone).
          "--cap-add",
          "DAC_READ_SEARCH",
          "--mount",
          `type=volume,src=${dockerName},dst=/volume,readonly`,
          "--entrypoint",
          "du",
          this.guardImage,
          "-sb",
          "/volume",
        ],
        MEASURE_TIMEOUT_MS,
      );
      const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
      return Number.isSafeInteger(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }

  /** Confirm the caller is configured before admission. */
  public validateCaller(spec: ResourceInstanceRecord["spec"]): void {
    this.caller.validate({ spec });
  }
  /** Stable DNS endpoint on the configured caller's private network. */
  public endpoint(instance: ResourceInstanceRecord): {
    readonly host: string;
    readonly port: number;
    readonly callbackHost: string;
  } {
    return this.caller.endpoint(instance);
  }
  /** Fresh caller-only health observation. */
  public health(instance: ResourceInstanceRecord): Promise<ResourceInstanceState> {
    return this.caller.health(instance);
  }
  /** A stopped caller-only volume, streamed as tar. */
  public backup(
    instance: ResourceInstanceRecord,
    volume: string,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.caller.backup(instance, volume);
  }

  public checkPurge(instance: ResourceInstanceRecord): Promise<void> {
    return this.caller.checkPurge(instance);
  }

  public purge(instance: ResourceInstanceRecord): Promise<void> {
    return this.caller.purge(instance);
  }

  public exec(
    instance: ResourceInstanceRecord,
    command: ResourceExecCommand,
    stdin: AsyncIterable<Uint8Array> | null,
  ): Promise<ResourceExecResult> {
    return new Promise((resolve, reject) => {
      // The streaming path: the buffered runner caps output at 10 MB and takes stdin as a string.
      const child = spawn(
        "docker",
        [
          ...execArgv(
            instance.spec.reach?.kind === "caller"
              ? `${callerInstanceName(instance.id)}-workload`
              : instanceContainerName(instance.id),
            command,
          ),
        ],
        {
          env: { ...process.env, DOCKER_HOST: `unix://${this.dockerSocketPath}` },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout = new Tail(RESOURCE_EXEC_OUTPUT_LIMIT);
      const stderr = new Tail(RESOURCE_EXEC_OUTPUT_LIMIT);
      let timedOut = false;
      let closed = false;
      let feedFailure: unknown;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, command.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => undefined);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        closed = true;
        clearTimeout(timer);
        if (feedFailure !== undefined) {
          reject(feedFailure);
          return;
        }
        resolve({
          exitCode: timedOut ? null : code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
        });
      });
      void (async () => {
        try {
          if (stdin !== null) {
            for await (const chunk of stdin) {
              if (closed || child.stdin.destroyed) break;
              if (!child.stdin.write(chunk)) {
                await new Promise<void>((drained) => {
                  child.stdin.once("drain", drained);
                  child.once("close", drained);
                });
              }
            }
          }
        } finally {
          child.stdin.end();
        }
      })().catch((error: unknown) => {
        // The caller's stdin failed (an upload cut off): the command must not see a short input.
        feedFailure = error;
        child.kill("SIGKILL");
      });
    });
  }

  public async attachExecutor(
    executor: string,
    attachments: ReadonlyArray<ReachAttachment>,
  ): Promise<void> {
    await this.convergeExecutor(executor, attachments);
  }

  public async detachExecutor(executor: string): Promise<void> {
    const network = reachNetworkName(executor);
    await this.removeNetwork(network, (members) => this.closeReach(executor, network, members));
  }

  public async converge(input: {
    readonly desired: ReadonlyArray<ReachAttachment>;
    readonly liveExecutors: ReadonlyArray<string>;
    readonly knownExecutors: ReadonlyArray<string>;
  }): Promise<void> {
    const live = new Set(input.liveExecutors);
    const listed = await this.run([
      "network",
      "ls",
      "--filter",
      `label=${RESOURCE_LABELS.network}=reach`,
      "--format",
      "{{.Name}}",
    ]);
    const present = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("-reach"));
    const gone = new Set([
      ...present.map((network) => network.slice(0, -"-reach".length)),
      ...input.knownExecutors,
    ]);
    // Boat's exact-target reconciler owns these networks through uncertain stops and FINAL cleanup.
    const external = new Set(
      [...gone, ...live].filter((executor) => /^boat-tunnel-[a-f0-9]{32}$/.test(executor)),
    );
    for (const executor of new Set([...gone, ...live])) {
      if (external.has(executor) || !(await this.networkExists(reachNetworkName(executor))))
        continue;
      const labels = await this.run([
        "network",
        "inspect",
        "--format",
        '{{index .Labels "sealant.boat-tunnel"}}',
        reachNetworkName(executor),
      ]);
      if (labels.stdout.trim() !== "" && labels.stdout.trim() !== "<no value>")
        external.add(executor);
    }
    for (const executor of external) {
      gone.delete(executor);
      live.delete(executor);
    }
    // An executor its row calls live but Docker no longer has is gone too.
    for (const executor of live) {
      if ((await this.inspectContainer(executor)) === undefined) live.delete(executor);
    }
    for (const executor of gone) {
      if (!live.has(executor)) await this.detachExecutor(executor);
    }
    let failure: unknown;
    for (const executor of live) {
      try {
        await this.convergeExecutor(executor, input.desired);
      } catch (error) {
        // One executor that cannot be reached (gone since its row was read) holds up no other.
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async convergeExecutor(
    executor: string,
    desired: ReadonlyArray<ReachAttachment>,
  ): Promise<void> {
    const network = reachNetworkName(executor);
    await this.ensureReach(executor);
    const wanted = desired.filter((attachment) => attachment.executor === executor);
    const held = new Set(await this.networkContainers(network));
    for (const attachment of wanted) {
      if (!held.has(attachment.container)) {
        await this.runTolerating(
          connectArgv(attachment),
          (error) => isPresent(error) || isMissing(error),
        );
      }
    }
    const keep = new Set(wanted.map((attachment) => attachment.container));
    for (const container of held) {
      if (container.startsWith("sealres-") && !keep.has(container)) {
        await this.runTolerating(
          disconnectArgv(network, container),
          (error) => isMissing(error) || isNotConnected(error),
        );
      }
    }
  }

  public async observe(): Promise<ReadonlyMap<string, ObservedContainer>> {
    // `ps` lists the containers, but its state comes from a view Docker updates after it releases
    // `docker stop`, so right after a stop it can still say running. `inspect` reads the state
    // `stop` waited on.
    const listed = await this.run([
      "ps",
      "-a",
      "--filter",
      `label=${RESOURCE_LABELS.instance}`,
      "--format",
      "{{.ID}}",
    ]);
    const containers = listed.stdout.split("\n").flatMap((line) => {
      const id = line.trim();
      return id.length === 0 ? [] : [id];
    });
    const observed = new Map<string, ObservedContainer>();
    if (containers.length === 0) return observed;
    const inspected = await this.run([
      "inspect",
      "--format",
      `{{index .Config.Labels "${RESOURCE_LABELS.instance}"}}\t{{.State.Status}}\t{{.State.ExitCode}}`,
      ...containers,
    ]).catch((error: unknown) => {
      // One removed since `ps` listed it: the others are still printed, and it is gone.
      if (
        isMissing(error) &&
        error instanceof Error &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        return { stdout: error.stdout, stderr: "" };
      }
      throw error;
    });
    for (const line of inspected.stdout.split("\n")) {
      const [id, status, exitCode] = line.trim().split("\t");
      if (id === undefined || id.length === 0) continue;
      observed.set(id, {
        running: status === "running",
        exitCode: status === "exited" && exitCode !== undefined ? Number(exitCode) : null,
      });
    }
    return observed;
  }
}
