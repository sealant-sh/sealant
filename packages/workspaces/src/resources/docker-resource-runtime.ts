/**
 * Resource instances on a Docker host: the shell that runs what `docker-resource-argv.ts` builds.
 * Each method reads what Docker holds and applies the difference, so running it twice finds
 * nothing left to do, and an API call and the reconciler's tick racing converge on the same names.
 *
 * Volumes outlive everything here: no method runs `docker rm -v`, `docker volume rm` or a prune.
 */
import { spawn } from "node:child_process";

import type { ResourceInstanceState, ResourceInstanceVolume } from "@sealant/api-contracts";
import type { ResourceInstanceRecord, ResourceNetworkKind } from "@sealant/db";

import {
  cloudMetadataGuardArgv,
  createDockerCommandRunner,
  DEFAULT_NETWORK_GUARD_IMAGE,
  type DockerCommandRunner,
} from "../runtime/docker-runtime-adapter.js";
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

/** Core's subnet pools (`ResourceInstanceRepo.allocateNetwork`), as the runtime needs them. */
export interface ResourceSubnets {
  /** The network's subnet, the one it already holds or a new one. Throws when the pool is full. */
  readonly allocate: (input: {
    readonly name: string;
    readonly kind: ResourceNetworkKind;
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
  /** The executor's reach network, created on Core's subnet, with the executor and each instance it reaches. */
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
/** Docker's own words for an object that is already there. */
const isPresent = (error: unknown) => /already exists|is already in use/i.test(errorText(error));
const isNotConnected = (error: unknown) => /is not connected/i.test(errorText(error));

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
  private readonly dockerSocketPath: string;
  private readonly guardImage: string;
  private readonly readyTimeoutMs: number;
  private readonly subnets: ResourceSubnets;

  public constructor(options: DockerResourceRuntimeOptions) {
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

  /** The network on Core's subnet: created when missing, its subnet held in Core's table. */
  private async ensureNetwork(name: string, kind: ResourceNetworkKind, owner: string) {
    if (await this.networkExists(name)) return;
    const subnet = await this.subnets.allocate({ name, kind, owner });
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

  private async removeNetwork(name: string): Promise<void> {
    if (await this.networkExists(name)) {
      for (const container of await this.networkContainers(name)) {
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

  /** The executor's reach network exists with the executor on it. */
  private async ensureReach(executor: string): Promise<void> {
    const network = reachNetworkName(executor);
    await this.ensureNetwork(network, "reach", executor);
    await this.runTolerating(["network", "connect", network, executor], isPresent);
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
    const container = instanceContainerName(instance.id);
    let volumes: ReadonlyArray<ResourceInstanceVolume>;
    try {
      await this.ensureNetwork(egressNetworkName(instance.id), "egress", instance.id);
      volumes = coverImageVolumes(
        instance.spec.volumes,
        await this.imageVolumes(instance.spec.image),
      );
      for (const volume of volumes) await this.run(volumeCreateArgv(instance, volume));
      let existing = await this.inspectContainer(container);
      if (existing !== undefined && existing.specDigest !== instance.specDigest) {
        // A changed spec is a new container over the same volumes.
        await this.stop(instance);
        await this.runTolerating(["rm", container], isMissing);
        existing = undefined;
      }
      if (existing === undefined) {
        // A name conflict is a concurrent `up` that created it first: adopt it.
        await this.runTolerating(instanceRunArgv(instance, volumes), isPresent);
      } else if (!existing.running) {
        await this.run(["start", container]);
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
    await this.runTolerating(
      ["stop", "-t", String(RESOURCE_STOP_TIMEOUT_SECONDS), instanceContainerName(instance.id)],
      isMissing,
    );
  }

  public async archive(instance: ResourceInstanceRecord): Promise<ReadonlyArray<ArchivedVolume>> {
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

  public exec(
    instance: ResourceInstanceRecord,
    command: ResourceExecCommand,
    stdin: AsyncIterable<Uint8Array> | null,
  ): Promise<ResourceExecResult> {
    return new Promise((resolve, reject) => {
      // The streaming path: the buffered runner caps output at 10 MB and takes stdin as a string.
      const child = spawn("docker", [...execArgv(instanceContainerName(instance.id), command)], {
        env: { ...process.env, DOCKER_HOST: `unix://${this.dockerSocketPath}` },
        stdio: ["pipe", "pipe", "pipe"],
      });
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
    await this.ensureReach(executor);
    await this.attach(attachments.filter((attachment) => attachment.executor === executor));
  }

  public async detachExecutor(executor: string): Promise<void> {
    await this.removeNetwork(reachNetworkName(executor));
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
    const result = await this.run([
      "ps",
      "-a",
      "--filter",
      `label=${RESOURCE_LABELS.instance}`,
      "--format",
      `{{.Label "${RESOURCE_LABELS.instance}"}}\t{{.State}}\t{{.Status}}`,
    ]);
    const observed = new Map<string, ObservedContainer>();
    for (const line of result.stdout.split("\n")) {
      const [id, state, status] = line.trim().split("\t");
      if (id === undefined || id.length === 0) continue;
      const exit = /Exited \((-?\d+)\)/.exec(status ?? "")?.[1];
      observed.set(id, {
        running: state === "running",
        exitCode: exit === undefined ? null : Number(exit),
      });
    }
    return observed;
  }
}
