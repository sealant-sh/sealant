import { spawn } from "node:child_process";
import { request } from "node:http";
import { isIP } from "node:net";

import {
  resourceInstanceSecretEnvSchema,
  ResourceInstancePurgeRefusedError,
  type ResourceInstanceState,
} from "@sealant/api-contracts";
import type { CredentialCipherService } from "@sealant/credentials";
import type { ResourceInstanceRecord } from "@sealant/db";
import { Effect, Schema } from "effect";

import {
  createDockerCommandRunner,
  type DockerCommandRunner,
} from "../runtime/docker-runtime-adapter.js";
import { callerInstanceName, type ResourceCallerConfig } from "./caller-config.js";
import type {
  ArchivedVolume,
  ResourceSubnets,
  ResourceUpResult,
} from "./docker-resource-runtime.js";

/** Pinned helper with iptables, nc and tar. Workloads never receive its NET_ADMIN capability. */
export const CALLER_GUARD_IMAGE =
  "nicolaka/netshoot@sha256:47b907d662d139d1e2f22bfe14f4efca1e3f1feed283572f47c970c780c03b61";
const decodeSecrets = Schema.decodeUnknownSync(
  Schema.fromJsonString(resourceInstanceSecretEnvSchema),
);
const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "stderr" in error &&
  typeof error.stderr === "string" &&
  /no such|not found/i.test(error.stderr);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class CallerDnsConfigurationError extends Schema.TaggedError<CallerDnsConfigurationError>()(
  "CallerDnsConfigurationError",
  {},
) {
  override readonly message =
    "The Docker caller DNS configuration is unavailable or unsupported. Docker must report IPv4 upstreams in its generated resolver file.";
}

const parseDnsResolvers = (config: string): ReadonlyArray<string> => {
  const nameservers = config
    .split("\n")
    .filter((line) => /^\s*nameserver\b/.test(line))
    .map((line) => {
      const fields = line.split("#")[0]?.trim().split(/\s+/);
      const address = fields?.[1];
      if (fields?.length !== 2 || address === undefined || isIP(address) === 0)
        throw new CallerDnsConfigurationError();
      return address;
    });
  // Docker's file describes the daemon's actual upstreams, unlike Core's own resolv.conf in
  // a packaged container. Never interpret the embedded loopback address as the upstream.
  const external = /^# ExtServers:\s*\[([^\]\n]*)\]\s*$/m.exec(config)?.[1];
  const addresses = nameservers.includes("127.0.0.11")
    ? external
        ?.trim()
        .split(/\s+/)
        .map((entry) => /^host\(([^)]+)\)$/.exec(entry)?.[1] ?? entry)
    : nameservers;
  if (addresses === undefined || addresses.some((address) => isIP(address) === 0))
    throw new CallerDnsConfigurationError();
  const ipv4 = [...new Set(addresses.filter((address) => isIP(address) === 4))];
  if (ipv4.length === 0) throw new CallerDnsConfigurationError();
  return ipv4;
};

/** Process env goes in an Engine request body, never command arguments, files or error messages. */
const engineCreate = (socketPath: string, name: string, body: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    const pending = request(
      {
        socketPath,
        path: `/containers/create?name=${encodeURIComponent(name)}`,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode === 201) resolve();
          else reject(new Error("The Docker Engine refused to create the caller instance."));
        });
        response.on("error", () => reject(new Error("The Docker Engine create response failed.")));
      },
    );
    pending.setTimeout(60_000, () =>
      pending.destroy(new Error("The Docker Engine create timed out.")),
    );
    pending.on("error", () => reject(new Error("The Docker Engine create request failed.")));
    pending.end(JSON.stringify(body));
  });

/** Guard rules are installed in the anchor before a workload can execute. IPv6 stays denied. */
export const callerGuardScript = (
  callerIp: string,
  servicePort: number,
  callbackPort: number,
  resolverConfig: string,
): string =>
  [
    "set -eu",
    "iptables -P INPUT DROP",
    "iptables -P OUTPUT DROP",
    "iptables -F INPUT",
    "iptables -F OUTPUT",
    "iptables -A INPUT -i lo -j ACCEPT",
    "iptables -A OUTPUT -o lo -j ACCEPT",
    "iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    `iptables -A INPUT -s ${callerIp}/32 -p tcp --dport ${String(servicePort)} -j ACCEPT`,
    `iptables -A OUTPUT -d ${callerIp}/32 -p tcp --dport ${String(callbackPort)} -j ACCEPT`,
    ...parseDnsResolvers(resolverConfig).flatMap((address) =>
      ["udp", "tcp"].map(
        (protocol) => `iptables -A OUTPUT -d ${address}/32 -p ${protocol} --dport 53 -j ACCEPT`,
      ),
    ),
    ...[
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ].map((range) => `iptables -A OUTPUT -d ${range} -j REJECT`),
    "iptables -A OUTPUT -j ACCEPT",
    "if [ -e /proc/net/if_inet6 ]; then ip6tables -P INPUT DROP; ip6tables -P OUTPUT DROP; fi",
  ].join("\n");

/** Docker caller-only workloads, including guarded namespaces and retained-volume downloads. */
export class DockerCallerRuntime {
  private readonly docker: DockerCommandRunner;
  private readonly socket: string;
  private readonly guard: string;
  /** All configuration is supplied at construction by the process boundary. */
  public constructor(
    private readonly options: {
      readonly subnets: ResourceSubnets;
      readonly callers: ResourceCallerConfig;
      readonly cipher?: CredentialCipherService;
      readonly dockerSocketPath?: string;
      readonly guardImage?: string;
      readonly readyTimeoutMs?: number;
    },
  ) {
    this.socket = options.dockerSocketPath ?? "/var/run/docker.sock";
    this.guard = options.guardImage ?? CALLER_GUARD_IMAGE;
    this.docker = createDockerCommandRunner(this.socket);
  }
  private run(args: ReadonlyArray<string>, input?: string) {
    return this.docker("docker", [...args], {
      timeoutMs: 15 * 60_000,
      ...(input === undefined ? {} : { input }),
    });
  }
  private async exists(kind: "container" | "network" | "volume", name: string): Promise<boolean> {
    try {
      await this.run([kind, "inspect", "--format", "{{.Name}}", name]);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  private async running(name: string): Promise<boolean> {
    if (!(await this.exists("container", name))) return false;
    return (
      (await this.run(["inspect", "--format", "{{.State.Running}}", name])).stdout.trim() === "true"
    );
  }
  private async network(name: string, kind: "caller" | "egress", owner: string): Promise<string> {
    const subnet = await this.options.subnets.allocate({ name, kind, owner });
    if (!(await this.exists("network", name))) {
      await this.run([
        "network",
        "create",
        "--driver",
        "bridge",
        ...(kind === "caller" ? ["--internal"] : []),
        "--subnet",
        subnet,
        "--label",
        "sealant.caller-resource=true",
        name,
      ]);
    }
    return subnet;
  }
  private async connect(network: string, container: string, alias: string): Promise<void> {
    const names = (
      await this.run([
        "network",
        "inspect",
        "--format",
        "{{range .Containers}}{{.Name}}\n{{end}}",
        network,
      ])
    ).stdout.split("\n");
    if (!names.includes(container))
      await this.run(["network", "connect", "--alias", alias, network, container]);
  }
  private caller(instance: ResourceInstanceRecord) {
    const reach = instance.spec.reach;
    const caller = this.options.callers.find((candidate) => candidate.name === reach?.caller);
    if (
      reach === undefined ||
      caller?.kind !== "docker" ||
      !caller.callbackPorts.includes(reach.callbackPort)
    )
      throw new Error("No Docker caller is configured for this instance and callback port.");
    return { reach, caller };
  }
  /** Validate the deployment binding before admitting an instance. */
  public validate(instance: Pick<ResourceInstanceRecord, "spec">): void {
    const reach = instance.spec.reach;
    const caller = this.options.callers.find((candidate) => candidate.name === reach?.caller);
    if (
      caller?.kind !== "docker" ||
      reach === undefined ||
      !caller.callbackPorts.includes(reach.callbackPort)
    )
      throw new Error("No Docker caller is configured for this instance and callback port.");
  }
  /** The anchor retains this DNS name across every workload replacement. */
  public endpoint(instance: ResourceInstanceRecord): {
    readonly host: string;
    readonly port: number;
    readonly callbackHost: string;
  } {
    const { reach } = this.caller(instance);
    return { host: callerInstanceName(instance.id), port: reach.port, callbackHost: reach.caller };
  }
  /** Only one deterministic workload container ever mounts these volumes for writing. */
  public async up(instance: ResourceInstanceRecord): Promise<ResourceUpResult> {
    const name = callerInstanceName(instance.id);
    const workload = `${name}-workload`;
    const volumes = instance.spec.volumes;
    const confirmedVolumes = [...instance.volumes];
    try {
      const { reach, caller } = this.caller(instance);
      await this.run(["image", "inspect", "--format", "{{.Id}}", instance.spec.image]).catch(() =>
        this.run(["pull", "-q", instance.spec.image]),
      );
      const declared: unknown = JSON.parse(
        (
          await this.run([
            "image",
            "inspect",
            "--format",
            "{{json .Config.Volumes}}",
            instance.spec.image,
          ])
        ).stdout,
      );
      if (
        typeof declared === "object" &&
        declared !== null &&
        Object.keys(declared).some((path) => !volumes.some((volume) => volume.mountPath === path))
      )
        throw new Error(
          "The image declares an unbudgeted volume. Name every image volume in the spec.",
        );
      for (const volume of volumes) {
        const volumeName = `${name}-${volume.name}`;
        if (!(await this.exists("volume", volumeName))) {
          if (instance.volumes.some((prior) => prior.name === volume.name))
            throw new Error(
              "A retained volume is missing. Restore it before starting this instance.",
            );
          await this.run([
            "volume",
            "create",
            "--label",
            `sealant.resource-instance=${instance.id}`,
            volumeName,
          ]);
        }
        if (!confirmedVolumes.some((prior) => prior.name === volume.name))
          confirmedVolumes.push(volume);
      }
      await this.network(`${name}-egress`, "egress", instance.id);
      const privateNet = `${name}-caller`;
      await this.network(privateNet, "caller", instance.id);
      if (!(await this.exists("container", name))) {
        // A workload cannot keep using a previous anchor's network namespace.
        if (await this.exists("container", workload)) {
          await this.stop(instance);
          await this.run(["rm", workload]);
        }
        await this.run([
          "run",
          "-d",
          "--name",
          name,
          "--label",
          `sealant.resource-instance-anchor=${instance.id}`,
          "--restart",
          "unless-stopped",
          "--network",
          `${name}-egress`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "sleep",
          this.guard,
          "infinity",
        ]);
      } else if (!(await this.running(name))) await this.run(["start", name]);
      await this.connect(privateNet, caller.container, reach.caller);
      await this.connect(privateNet, name, name);
      const callerIp = (
        await this.run([
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${privateNet}").IPAddress}}`,
          caller.container,
        ])
      ).stdout.trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(callerIp))
        throw new Error("The caller has no private address.");
      const resolverConfig = (await this.run(["exec", name, "cat", "/etc/resolv.conf"])).stdout;
      const guardScript = callerGuardScript(
        callerIp,
        reach.port,
        reach.callbackPort,
        resolverConfig,
      );
      await this.run([
        "run",
        "--rm",
        "--name",
        `${name}-guard`,
        "--network",
        `container:${name}`,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        this.guard,
        "-c",
        guardScript,
      ]);
      const anchorIp = (
        await this.run([
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${privateNet}").IPAddress}}`,
          name,
        ])
      ).stdout.trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(anchorIp))
        throw new Error("The instance has no private address.");
      const chain = `CORESVC_CB_${String(reach.callbackPort)}`;
      // Mend may share its container with Core and workspace-facing listeners. Restrict just
      // this configured callback port on every interface, leaving those other listeners alone.
      const callbackGuard = [
        "set -eu",
        `iptables -N ${chain} 2>/dev/null || true`,
        `iptables -C ${chain} -j REJECT 2>/dev/null || iptables -A ${chain} -j REJECT`,
        `iptables -C ${chain} -i lo -j ACCEPT 2>/dev/null || iptables -I ${chain} 1 -i lo -j ACCEPT`,
        `iptables -C ${chain} -s ${anchorIp}/32 -m comment --comment ${name} -j ACCEPT 2>/dev/null || iptables -I ${chain} 1 -s ${anchorIp}/32 -m comment --comment ${name} -j ACCEPT`,
        `iptables -C INPUT -p tcp --dport ${String(reach.callbackPort)} -j ${chain} 2>/dev/null || iptables -I INPUT 1 -p tcp --dport ${String(reach.callbackPort)} -j ${chain}`,
        `if [ -e /proc/net/if_inet6 ]; then ip6tables -C INPUT -p tcp --dport ${String(reach.callbackPort)} -j REJECT 2>/dev/null || ip6tables -I INPUT 1 -p tcp --dport ${String(reach.callbackPort)} -j REJECT; fi`,
      ].join("\n");
      await this.run([
        "run",
        "--rm",
        "--name",
        `${name}-caller-guard`,
        "--network",
        `container:${caller.container}`,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        this.guard,
        "-c",
        callbackGuard,
      ]);
      const anchorEpoch = (
        await this.run(["inspect", "--format", "{{.State.StartedAt}}", name])
      ).stdout.trim();
      if (await this.exists("container", workload)) {
        const digest = (
          await this.run([
            "inspect",
            "--format",
            '{{index .Config.Labels "sealant.resource-spec-digest"}}',
            workload,
          ])
        ).stdout.trim();
        const previousAnchor = (
          await this.run([
            "inspect",
            "--format",
            '{{index .Config.Labels "sealant.resource-anchor-epoch"}}',
            workload,
          ])
        ).stdout.trim();
        const resolverReadOnly =
          (
            await this.run([
              "inspect",
              "--format",
              '{{range .Mounts}}{{if eq .Destination "/etc/resolv.conf"}}{{.RW}}{{end}}{{end}}',
              workload,
            ])
          ).stdout.trim() === "false";
        if (
          digest !== instance.specDigest ||
          previousAnchor !== anchorEpoch ||
          !resolverReadOnly ||
          !(await this.running(workload))
        ) {
          await this.stop(instance);
          await this.run(["rm", workload]);
        }
      }
      if (!(await this.exists("container", workload))) {
        const resolverPath = (
          await this.run(["inspect", "--format", "{{.ResolvConfPath}}", name])
        ).stdout.trim();
        let secretEnv: Readonly<Record<string, string>> = {};
        if (instance.secretEnvSealed != null) {
          if (this.options.cipher === undefined)
            throw new Error("The credential cipher is required to start this instance.");
          secretEnv = decodeSecrets(
            await Effect.runPromise(this.options.cipher.decrypt(instance.secretEnvSealed)),
          );
        }
        await engineCreate(this.socket, workload, {
          Image: instance.spec.image,
          ...(instance.spec.command === null ? {} : { Cmd: instance.spec.command }),
          Labels: {
            "sealant.resource-instance": instance.id,
            "sealant.resource-spec-digest": instance.specDigest,
            "sealant.resource-anchor-epoch": anchorEpoch,
          },
          Env: Object.entries({ ...instance.spec.env, ...secretEnv }).map(
            ([key, value]) => `${key}=${value}`,
          ),
          HostConfig: {
            NetworkMode: `container:${name}`,
            RestartPolicy: { Name: "no" },
            Memory: instance.spec.limits.memoryBytes,
            NanoCpus: instance.spec.limits.cpuMillicores * 1_000_000,
            PidsLimit: 1024,
            CapDrop: ["NET_RAW"],
            SecurityOpt: ["no-new-privileges:true"],
            Mounts: [
              ...volumes.map((volume) => ({
                Type: "volume",
                Source: `${name}-${volume.name}`,
                Target: volume.mountPath,
              })),
              {
                // The shared generated file supplies the next guard's allowlist. The workload
                // must not rewrite its ExtServers metadata to nominate another private peer.
                Type: "bind",
                Source: resolverPath,
                Target: "/etc/resolv.conf",
                ReadOnly: true,
              },
            ],
          },
        });
        await this.run(["start", workload]);
      }
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120_000);
      do {
        if (!(await this.running(workload)))
          throw new Error("The caller instance exited before its health check answered.");
        if (await this.probe(instance)) {
          const startedAt = new Date(
            (
              await this.run(["inspect", "--format", "{{.State.StartedAt}}", workload])
            ).stdout.trim(),
          );
          return { state: { kind: "running", since: startedAt.toISOString() }, volumes, startedAt };
        }
        await delay(1000);
      } while (Date.now() < deadline);
      throw new Error("The caller instance health check timed out.");
    } catch (error) {
      if (await this.exists("container", workload).catch(() => false))
        await this.run(["stop", "-t", "10", workload]).catch(() => undefined);
      // Engine and probe errors may repeat process env or output. Never persist them.
      return {
        state: {
          kind: "failed",
          at: new Date().toISOString(),
          message:
            error instanceof CallerDnsConfigurationError
              ? error.message
              : "The caller instance could not start. Check its image, retained volumes, caller configuration and health check.",
        },
        volumes: confirmedVolumes,
      };
    }
  }
  private async probe(instance: ResourceInstanceRecord): Promise<boolean> {
    const name = callerInstanceName(instance.id);
    const ready = instance.spec.ready;
    const args =
      ready.kind === "exec"
        ? [
            "exec",
            ...(ready.user === null ? [] : ["--user", ready.user]),
            `${name}-workload`,
            ...ready.argv,
          ]
        : [
            "run",
            "--rm",
            "--name",
            `${name}-probe`,
            "--network",
            `container:${name}`,
            "--cap-drop",
            "ALL",
            "--entrypoint",
            "nc",
            this.guard,
            "-z",
            "-w",
            "2",
            "127.0.0.1",
            String(ready.port),
          ];
    return this.run(args).then(
      () => true,
      () => false,
    );
  }
  /** Reports a fresh probe rather than trusting the last successful start. */
  public async health(instance: ResourceInstanceRecord): Promise<ResourceInstanceState> {
    if (!(await this.running(`${callerInstanceName(instance.id)}-workload`)))
      return { kind: "exited", at: new Date().toISOString(), exitCode: null };
    return (await this.probe(instance))
      ? { kind: "running", since: (instance.startedAt ?? new Date()).toISOString() }
      : {
          kind: "failed",
          at: new Date().toISOString(),
          message: "The caller instance health check did not answer.",
        };
  }
  /** Graceful stop, followed by a provider confirmation before compute is released. */
  public async stop(instance: ResourceInstanceRecord): Promise<void> {
    const workload = `${callerInstanceName(instance.id)}-workload`;
    if (await this.exists("container", workload)) await this.run(["stop", "-t", "60", workload]);
    if (await this.running(workload)) throw new Error("The caller instance has not stopped.");
  }
  /** A desired stop alone cannot authorize deleting a workload still running in Docker. */
  public async checkPurge(instance: ResourceInstanceRecord): Promise<void> {
    if (
      instance.spec.reach?.kind !== "caller" ||
      instance.desired === "running" ||
      (await this.running(`${callerInstanceName(instance.id)}-workload`))
    )
      throw new ResourceInstancePurgeRefusedError({
        message: "Stop or archive the caller instance before purging it.",
      });
  }
  /** Exact owned names only. Missing objects are successful retries; other errors keep the row. */
  public async purge(instance: ResourceInstanceRecord): Promise<void> {
    await this.checkPurge(instance);
    const name = callerInstanceName(instance.id);
    for (const suffix of ["backup", "probe", "guard", "caller-guard"]) {
      const helper = `${name}-${suffix}`;
      if (await this.exists("container", helper)) await this.run(["rm", "-f", helper]);
    }
    await this.archive(instance);
    const volumes = new Set(
      [...instance.spec.volumes, ...instance.volumes].map((volume) => volume.name),
    );
    for (const volume of volumes) {
      const owned = `${name}-${volume}`;
      if (await this.exists("volume", owned)) await this.run(["volume", "rm", owned]);
      if (await this.exists("volume", owned)) throw new Error("The purged volume still exists.");
    }
  }
  /** Removes only the workload and anchor; every retained named volume stays. */
  public async archive(instance: ResourceInstanceRecord): Promise<ReadonlyArray<ArchivedVolume>> {
    await this.stop(instance);
    const name = callerInstanceName(instance.id);
    const { caller, reach } = this.caller(instance);
    if (await this.running(caller.container)) {
      const chain = `CORESVC_CB_${String(reach.callbackPort)}`;
      // Delete exact rules carrying this instance's comment. Other organizations may add rules
      // concurrently, so line-number deletion would risk removing their access instead.
      const remove = `iptables -S ${chain} 2>/dev/null | grep -F -- ${name} | sed 's/^-A /-D /;s/"//g' | while read -r rule; do iptables $rule; done`;
      await this.run([
        "run",
        "--rm",
        "--name",
        `${name}-caller-guard`,
        "--network",
        `container:${caller.container}`,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        this.guard,
        "-c",
        remove,
      ]);
    }
    for (const container of [`${name}-workload`, name])
      if (await this.exists("container", container)) await this.run(["rm", "-f", container]);
    for (const network of [`${name}-caller`, `${name}-egress`]) {
      if (await this.exists("network", network)) {
        const members = (
          await this.run([
            "network",
            "inspect",
            "--format",
            "{{range .Containers}}{{.Name}}\n{{end}}",
            network,
          ])
        ).stdout
          .split("\n")
          .filter(Boolean);
        for (const member of members)
          await this.run(["network", "disconnect", "--force", network, member]);
        await this.run(["network", "rm", network]);
      }
      await this.options.subnets.release(network);
    }
    return (instance.volumes.length > 0 ? instance.volumes : instance.spec.volumes).map(
      (volume) => ({ name: volume.name, dockerName: `${name}-${volume.name}`, bytes: null }),
    );
  }
  /** Read-only tar, with backpressure and cancellation. The caller holds the instance lock. */
  public async backup(
    instance: ResourceInstanceRecord,
    volume: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const name = callerInstanceName(instance.id);
    if (instance.desired !== "stopped" || (await this.running(`${name}-workload`)))
      throw new Error("Stop the instance before backing up its volume.");
    if (
      !(instance.volumes.length > 0 ? instance.volumes : instance.spec.volumes).some(
        (candidate) => candidate.name === volume,
      ) ||
      !(await this.exists("volume", `${name}-${volume}`))
    )
      throw new Error("The retained volume is missing.");
    const helper = `${name}-backup`;
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        helper,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_READ_SEARCH",
        "--mount",
        `type=volume,src=${name}-${volume},dst=/volume,readonly`,
        "--entrypoint",
        "tar",
        this.guard,
        "-C",
        "/volume",
        "-cf",
        "-",
        ".",
      ],
      {
        env: { ...process.env, DOCKER_HOST: `unix://${this.socket}` },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const iterator = child.stdout[Symbol.asyncIterator]();
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", () => reject(new Error("The backup helper could not start.")));
    });
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = await iterator.next();
        if (next.done === true) {
          if ((await completion) !== 0) controller.error(new Error("The volume backup failed."));
          else controller.close();
        } else
          controller.enqueue(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
      },
      cancel: async () => {
        await this.run(["rm", "-f", helper]).catch(() => undefined);
        child.kill();
        await completion.catch(() => undefined);
      },
    });
  }
}
