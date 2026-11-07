import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ResourceInstanceRecord, ResourceWorkspaceLink } from "@sealant/db";
import { boatExecutionTargetSchema, type BoatExecutionTarget } from "@sealant/validators";
import { Effect, Redacted } from "effect";
import { z } from "zod";

import {
  createDockerCommandRunner,
  type DockerCommandRunner,
} from "../runtime/docker-runtime-adapter.js";
import { reachNetworkName, RESOURCE_LABELS } from "./docker-resource-argv.js";
import type { ResourceRuntime, ResourceSubnets } from "./docker-resource-runtime.js";
import { desiredAttachments } from "./reach.js";

const OWNER = "sealant.boat-tunnel";
const CONFIG = "sealant.boat-tunnel-config";
const PROGRAM = "/usr/local/lib/sealant/gateway.py";
const key = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return (
      bytes.length === 32 && bytes.some((byte) => byte !== 0) && bytes.toString("base64") === value
    );
  });
const image = z.string().regex(/^(?:[a-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/);
const port = z.number().int().min(1).max(65535);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bindingOf = (target: BoatExecutionTarget) =>
  hash(JSON.stringify(boatExecutionTargetSchema.parse(target)));
const networkSchema = z.object({
  Driver: z.literal("bridge"),
  Internal: z.boolean(),
  Labels: z.record(z.string(), z.string()),
  IPAM: z.object({
    Config: z.array(z.object({ Subnet: z.string(), Gateway: z.string() })).length(1),
  }),
  Containers: z.record(z.string(), z.object({ Name: z.string() })).default({}),
});
const containerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Image: z.string(),
  Config: z.object({
    Labels: z.record(z.string(), z.string()),
    User: z.string(),
    Entrypoint: z.array(z.string()),
    Cmd: z.array(z.string()),
  }),
  State: z.object({ Running: z.boolean(), StartedAt: z.string() }),
  HostConfig: z.object({
    Privileged: z.boolean(),
    ReadonlyRootfs: z.boolean(),
    CapAdd: z.array(z.string()),
    CapDrop: z.array(z.string()),
    SecurityOpt: z.array(z.string()),
    Memory: z.number(),
    NanoCpus: z.number(),
    PidsLimit: z.number(),
    RestartPolicy: z.object({ Name: z.string() }),
    Tmpfs: z.record(z.string(), z.string()),
    PortBindings: z.record(
      z.string(),
      z.array(z.object({ HostIp: z.string(), HostPort: z.string() })),
    ),
    Sysctls: z.record(z.string(), z.string()),
    Binds: z.array(z.string()).nullable(),
    NetworkMode: z.string(),
    PidMode: z.string(),
    IpcMode: z.string(),
  }),
  Mounts: z.array(z.object({ Type: z.string(), Destination: z.string() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
});
const statusSchema = z.strictObject({
  format: z.literal("sealant-resource-gateway-status-v1"),
  config: z.strictObject({
    format: z.literal("sealant-resource-tunnel-v1"),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: key,
    peerKey: key,
    subnet: z.string(),
    bridge: z.string(),
  }),
  gateway: z.literal("100.127.255.253"),
  client: z.literal("100.127.255.254"),
  dns: z.literal("udp-and-tcp"),
  peerHandshake: z.literal("unverified"),
});

/** Safe failure codes never contain Docker argv, request bodies or WireGuard key material. */
export class BoatTunnelError extends Error {
  readonly _tag = "BoatTunnelError";
  constructor(readonly code: "invalid-input" | "ownership-conflict" | "gateway-unavailable") {
    super(`Boat resource tunnel: ${code}`);
  }
}

/** The durable caller freezes the target, key and UDP port before invoking this adapter. */
export interface BoatTunnelInput {
  readonly target: BoatExecutionTarget;
  readonly privateKey: Redacted.Redacted<string>;
  readonly peerKey: string;
  readonly listenPort: number;
  readonly link: ResourceWorkspaceLink;
  readonly instances: readonly ResourceInstanceRecord[];
}

/** Endpoint acknowledgement only. This never establishes guest connectivity or daemon readiness. */
export interface BoatTunnelEndpoint {
  readonly container: string;
  readonly containerId: string;
  /** A restart invalidates the previous acknowledgement and requires a fresh peer handshake. */
  readonly gatewayEpoch: string;
  readonly binding: string;
  readonly publicKey: string;
  readonly peerKey: string;
  readonly listenPort: number;
  readonly reachSubnet: string;
  readonly gateway: "100.127.255.253";
  readonly client: "100.127.255.254";
  readonly receipt: string;
  readonly peerHandshake: "unverified";
}

/** Host endpoint lifecycle only; the caller owns durable issuance, key custody and admission. */
export interface BoatTunnel {
  readonly ensure: (input: BoatTunnelInput) => Effect.Effect<BoatTunnelEndpoint, BoatTunnelError>;
  readonly remove: (target: BoatExecutionTarget) => Effect.Effect<void, BoatTunnelError>;
}

/** One stable Docker gateway name per deployment and run, outside the workspace exit watcher. */
export const boatTunnelName = (target: BoatExecutionTarget): string => {
  const parsed = boatExecutionTargetSchema.parse(target);
  return `boat-tunnel-${hash(JSON.stringify([parsed.deploymentId, parsed.runId])).slice(0, 32)}`;
};

/** Docker implementation of a single-peer encrypted endpoint in the existing resource reach network. */
export class DockerBoatTunnel implements BoatTunnel {
  private readonly docker: DockerCommandRunner;
  /** The image must be a locally available immutable digest, never a mutable tag. */
  constructor(
    private readonly options: {
      readonly gatewayImage: string;
      readonly subnets: ResourceSubnets;
      readonly resources: Pick<ResourceRuntime, "attachExecutor" | "detachExecutor">;
      readonly dockerSocketPath?: string;
    },
  ) {
    this.docker = createDockerCommandRunner(options.dockerSocketPath ?? "/var/run/docker.sock");
  }
  private run(args: readonly string[], input?: string) {
    return this.docker("docker", [...args], {
      timeoutMs: 15_000,
      ...(input === undefined ? {} : { input }),
    });
  }
  private async exists(kind: "container" | "network", name: string): Promise<boolean> {
    // List first: an unavailable daemon must never be mistaken for absence after an inspect error.
    const result = await this.run(
      kind === "container"
        ? ["ps", "-a", "--format", "{{.Names}}"]
        : ["network", "ls", "--format", "{{.Name}}"],
    );
    return result.stdout.split("\n").includes(name);
  }
  private async network(name: string) {
    return networkSchema.parse(
      JSON.parse((await this.run(["network", "inspect", "--format", "{{json .}}", name])).stdout),
    );
  }
  private async ownedContainer(name: string, binding: string, config?: string) {
    if (!(await this.exists("container", name))) return undefined;
    const raw: unknown = JSON.parse(
      (await this.run(["inspect", "--format", "{{json .}}", name])).stdout,
    );
    const identity = z
      .object({ Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }) })
      .parse(raw);
    if (
      identity.Config.Labels?.[OWNER] !== binding ||
      (config !== undefined && identity.Config.Labels?.[CONFIG] !== config)
    )
      throw new BoatTunnelError("ownership-conflict");
    return containerSchema.parse(raw);
  }
  private async ensureNetwork(
    name: string,
    kind: "reach" | "egress",
    owner: string,
    binding: string,
  ): Promise<void> {
    const subnet = await this.options.subnets.allocate({ name, kind, owner });
    const [address, prefix] = z
      .tuple([z.ipv4(), z.literal(kind === "reach" ? "27" : "28")])
      .parse(subnet.split("/"));
    const octets = address.split(".");
    const lastOctet = Number(octets.pop());
    if (lastOctet % 2 ** (32 - Number(prefix)) !== 0) throw new BoatTunnelError("invalid-input");
    // Docker 28 omits an automatically chosen gateway from network inspection.
    const gateway = [...octets, lastOctet + 1].join(".");
    if (!(await this.exists("network", name))) {
      try {
        await this.run([
          "network",
          "create",
          "--driver",
          "bridge",
          ...(kind === "reach" ? ["--internal"] : []),
          "--subnet",
          subnet,
          "--gateway",
          gateway,
          "--label",
          `${OWNER}=${binding}`,
          "--label",
          `${RESOURCE_LABELS.network}=${kind}`,
          name,
        ]);
      } catch {
        // A racing exact creator may have won. Only positive owned inspection permits adoption.
      }
    }
    const value = await this.network(name);
    if (
      value.Internal !== (kind === "reach") ||
      value.Labels[OWNER] !== binding ||
      value.IPAM.Config[0]?.Subnet !== subnet ||
      value.IPAM.Config[0]?.Gateway !== gateway
    )
      throw new BoatTunnelError("ownership-conflict");
  }
  /** Replays use the same container, peer and port. Unknown results leave owned obligations in place. */
  ensure(input: BoatTunnelInput): Effect.Effect<BoatTunnelEndpoint, BoatTunnelError> {
    return Effect.tryPromise({
      try: async (): Promise<BoatTunnelEndpoint> => {
        let target: BoatExecutionTarget;
        let privateKey: string;
        let publicKey: string;
        let peerKey: string;
        let listenPort: number;
        let gatewayImage: string;
        try {
          target = boatExecutionTargetSchema.parse(input.target);
          if (target.workspaceId !== input.link.workspaceId) throw new Error();
          privateKey = key.parse(Redacted.value(input.privateKey));
          peerKey = key.parse(input.peerKey);
          listenPort = port.parse(input.listenPort);
          gatewayImage = image.parse(this.options.gatewayImage);
          const privateObject = createPrivateKey({
            key: Buffer.concat([
              Buffer.from("302e020100300506032b656e04220420", "hex"),
              Buffer.from(privateKey, "base64"),
            ]),
            format: "der",
            type: "pkcs8",
          });
          publicKey = createPublicKey(privateObject)
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64");
          if (peerKey === publicKey) throw new Error();
        } catch {
          throw new BoatTunnelError("invalid-input");
        }
        const name = boatTunnelName(target);
        const binding = bindingOf(target);
        const configDigest = hash(
          JSON.stringify({ binding, publicKey, peerKey, listenPort, gatewayImage }),
        );
        const egress = `${name}-egress`;
        const imageId = z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .parse(
            (
              await this.run(["image", "inspect", "--format", "{{.Id}}", gatewayImage])
            ).stdout.trim(),
          );
        await this.ensureNetwork(egress, "egress", name, binding);
        await this.ensureNetwork(reachNetworkName(name), "reach", name, binding);
        let container = await this.ownedContainer(name, binding, configDigest);
        if (container === undefined) {
          try {
            await this.run([
              "create",
              "--name",
              name,
              "--label",
              `${OWNER}=${binding}`,
              "--label",
              `${CONFIG}=${configDigest}`,
              "--network",
              egress,
              "--publish",
              `${listenPort}:51820/udp`,
              "--restart",
              "no",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--cap-add",
              "NET_ADMIN",
              "--security-opt",
              "no-new-privileges:true",
              "--memory",
              "134217728",
              "--cpus",
              "0.5",
              "--pids-limit",
              "64",
              "--sysctl",
              "net.ipv4.ip_forward=1",
              "--sysctl",
              "net.ipv6.conf.all.disable_ipv6=1",
              "--tmpfs",
              "/run/sealant-tunnel:rw,nosuid,nodev,noexec,size=1m,mode=0700",
              gatewayImage,
            ]);
          } catch {
            // Never remove or replace on an ambiguous create response.
          }
          container = await this.ownedContainer(name, binding, configDigest);
        }
        if (container === undefined) throw new BoatTunnelError("gateway-unavailable");
        if (container.Image !== imageId) throw new BoatTunnelError("ownership-conflict");
        const host = container.HostConfig;
        if (
          host.Privileged ||
          !host.ReadonlyRootfs ||
          !isDeepStrictEqual(
            host.CapAdd.map((value) => value.replace(/^CAP_/, "")),
            ["NET_ADMIN"],
          ) ||
          !isDeepStrictEqual(host.CapDrop, ["ALL"]) ||
          !isDeepStrictEqual(host.SecurityOpt, ["no-new-privileges:true"]) ||
          host.Memory !== 134217728 ||
          host.NanoCpus !== 500000000 ||
          host.PidsLimit !== 64 ||
          host.RestartPolicy.Name !== "no" ||
          host.NetworkMode !== egress ||
          host.PidMode !== "" ||
          host.IpcMode !== "private" ||
          (host.Binds !== null && host.Binds.length !== 0) ||
          container.Mounts.some(
            (mount) => mount.Type !== "tmpfs" || mount.Destination !== "/run/sealant-tunnel",
          ) ||
          !isDeepStrictEqual(host.Tmpfs, {
            "/run/sealant-tunnel": "rw,nosuid,nodev,noexec,size=1m,mode=0700",
          }) ||
          !isDeepStrictEqual(host.Sysctls, {
            "net.ipv4.ip_forward": "1",
            "net.ipv6.conf.all.disable_ipv6": "1",
          }) ||
          !isDeepStrictEqual(host.PortBindings, {
            "51820/udp": [{ HostIp: "", HostPort: String(listenPort) }],
          }) ||
          container.Config.User !== "root" ||
          !isDeepStrictEqual(container.Config.Entrypoint, ["python3", "-I", "-B", PROGRAM]) ||
          !isDeepStrictEqual(container.Config.Cmd, ["serve"]) ||
          Object.keys(container.NetworkSettings.Networks).some(
            (network) => network !== egress && network !== reachNetworkName(name),
          )
        )
          throw new BoatTunnelError("ownership-conflict");
        if (!container.State.Running) await this.run(["start", name]);
        const attachments = desiredAttachments(
          [{ ...input.link, executor: name }],
          input.instances,
        );
        await this.options.resources.attachExecutor(name, attachments);
        const attached = await this.ownedContainer(name, binding, configDigest);
        if (
          attached === undefined ||
          !isDeepStrictEqual(
            Object.keys(attached.NetworkSettings.Networks).toSorted(),
            [egress, reachNetworkName(name)].toSorted(),
          )
        )
          throw new BoatTunnelError("ownership-conflict");
        const reach = await this.network(reachNetworkName(name));
        const subnet = reach.IPAM.Config[0];
        const wanted = new Set([name, ...attachments.map((entry) => entry.container)]);
        if (
          !reach.Internal ||
          reach.Labels[OWNER] !== binding ||
          reach.Labels[RESOURCE_LABELS.network] !== "reach" ||
          subnet === undefined ||
          Object.values(reach.Containers).some((entry) => !wanted.delete(entry.Name)) ||
          wanted.size !== 0
        )
          throw new BoatTunnelError("ownership-conflict");
        const egressObserved = await this.network(egress);
        if (Object.values(egressObserved.Containers).some((entry) => entry.Name !== name))
          throw new BoatTunnelError("ownership-conflict");
        const config = {
          format: "sealant-resource-tunnel-v1",
          binding,
          publicKey,
          peerKey,
          subnet: subnet.Subnet,
          bridge: subnet.Gateway,
        };
        await this.run(
          ["exec", "-i", name, "python3", "-I", "-B", PROGRAM, "configure"],
          JSON.stringify({ ...config, privateKey }),
        );
        let observed: z.infer<typeof statusSchema> | undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            observed = statusSchema.parse(
              JSON.parse(
                (await this.run(["exec", name, "python3", "-I", "-B", PROGRAM, "status"])).stdout,
              ),
            );
            break;
          } catch {
            if (attempt === 19) throw new BoatTunnelError("gateway-unavailable");
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        if (observed === undefined || !isDeepStrictEqual(observed.config, config))
          throw new BoatTunnelError("ownership-conflict");
        const receipt = hash(
          JSON.stringify({
            configDigest,
            containerId: container.Id,
            gatewayEpoch: attached.State.StartedAt,
            subnet: subnet.Subnet,
            gateway: observed.gateway,
            client: observed.client,
            attachments: attachments
              .map((entry) => [entry.instanceId, entry.alias])
              .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          }),
        );
        return {
          container: name,
          containerId: container.Id,
          gatewayEpoch: attached.State.StartedAt,
          binding,
          publicKey,
          peerKey,
          listenPort,
          reachSubnet: subnet.Subnet,
          gateway: observed.gateway,
          client: observed.client,
          receipt,
          peerHandshake: "unverified",
        };
      },
      catch: (error) =>
        error instanceof BoatTunnelError ? error : new BoatTunnelError("gateway-unavailable"),
    });
  }
  /** Removes only the exact target's gateway and networks. Resources and their volumes remain. */
  remove(target: BoatExecutionTarget): Effect.Effect<void, BoatTunnelError> {
    return Effect.tryPromise({
      try: async () => {
        const name = boatTunnelName(target);
        const binding = bindingOf(target);
        const held = await this.ownedContainer(name, binding);
        const reach = reachNetworkName(name);
        if (await this.exists("network", reach)) {
          const value = await this.network(reach);
          if (
            !value.Internal ||
            value.Labels[OWNER] !== binding ||
            Object.values(value.Containers).some(
              (entry) => entry.Name !== name && !entry.Name.startsWith("sealres-"),
            )
          )
            throw new BoatTunnelError("ownership-conflict");
        }
        if (held !== undefined) await this.run(["rm", "-f", held.Id]);
        await this.options.resources.detachExecutor(name);
        const egress = `${name}-egress`;
        if (await this.exists("network", egress)) {
          const value = await this.network(egress);
          if (value.Labels[OWNER] !== binding || Object.keys(value.Containers).length !== 0)
            throw new BoatTunnelError("ownership-conflict");
          await this.run(["network", "rm", egress]);
        }
        await this.options.subnets.release(egress);
      },
      catch: (error) =>
        error instanceof BoatTunnelError ? error : new BoatTunnelError("gateway-unavailable"),
    });
  }
}
