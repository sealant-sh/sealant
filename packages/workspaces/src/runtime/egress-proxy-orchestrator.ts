/**
 * `EgressProxyOrchestrator`: runs a workspace's own egress proxy, `<name>-proxy`, on a Docker host
 * (workspace isolation architecture §3.1, §7). Shared by every runtime whose workspace sits behind
 * one: the Docker runtime's proxy-backed workspaces, and the host-vm runner.
 *
 * Topology, per workspace container `<name>`:
 *
 * - `<name>-isolated`: an `--internal` bridge with no host-side gateway address
 *   (`gateway_mode_ipv4=isolated`), from sealant's subnet pool. The workspace is on it alone with
 *   its proxy, which holds the subnet's last address and binds every listener to it, never
 *   `0.0.0.0`.
 * - `<name>-proxy-egress`: the proxy's own route out, a plain bridge from the same pool. Never a
 *   shared network: no other workspace, and no control-plane service, is on it. The registry
 *   mirrors join it, so the proxy reaches them by name.
 * - The worktree's reach networks, when it has resources: the proxy joins them and answers the
 *   workspace for each resource on a synthetic address in `10.201.0.0/16`.
 *
 * The proxy runs read-only, as uid 65532, with every capability dropped, no new privileges, and
 * only the unprivileged-port sysctl it needs for DNS on 53. Its admin socket is on the control
 * directory's `<name>-proxy` subpath, which the workspace never mounts. It starts closed: nothing
 * passes until sealant pushes its first policy, and the workspace is released only after that.
 */
import { chmod, chown, mkdir } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { cidr, formatCidr } from "./cidr.js";
import type { DockerCommandRunner } from "./docker-runtime-adapter.js";
import { mirrorConnectArgv, type WorkspaceMirrorContainer } from "./docker-egress.js";
import { isolatedNetworkCreateArgv } from "./docker-isolated-network.js";
import {
  createProxyAdminClient,
  ProxyAdminRefusedError,
  type ProxyAdminClient,
  type ProxyHealth,
  type ProxyHeartbeat,
  type ProxyPolicyApplied,
  type ProxyPolicyDocument,
  type ProxyRevokeRequest,
} from "./proxy-admin-client.js";

/**
 * The proxy image (`SEALANT_EGRESS_PROXY_IMAGE` replaces it). A placeholder until sealantd's
 * release pipeline publishes the image (SLNT-1317); it is pinned by digest before release.
 */
export const DEFAULT_EGRESS_PROXY_IMAGE = "ghcr.io/sealant-sh/egress-proxy-next:0.21.0-next.0";

/** The proxy image's user: the admin socket's directory is handed to it. */
export const EGRESS_PROXY_UID = 65_532;

/** Where the proxy's control subpath is mounted inside it, and its admin socket there. */
export const EGRESS_PROXY_CONTROL_MOUNT = "/run/sealant";
export const EGRESS_PROXY_ADMIN_SOCKET = `${EGRESS_PROXY_CONTROL_MOUNT}/proxy-admin.sock`;

/** The ports the proxy listens on (its CLI defaults), each bound to its internal address. */
export const EGRESS_PROXY_PORTS = {
  httpProxy: 8080,
  transparentHttp: 15_080,
  transparentHttps: 15_443,
  transparentTcp: 15_444,
  transparentResource: 15_100,
  dns: 53,
} as const;

export const EGRESS_PROXY_LABEL = "sealant.egress-proxy";
const ISOLATED_NETWORK_LABEL = "sealant.workspace-isolated";
const PROXY_EGRESS_NETWORK_LABEL = "sealant.proxy-egress";

/** How long a starting proxy has to answer `GET /v1/health`. */
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;

export const egressProxyName = (workspaceContainer: string): string => `${workspaceContainer}-proxy`;
export const isolatedNetworkName = (workspaceContainer: string): string =>
  `${workspaceContainer}-isolated`;
export const proxyEgressNetworkName = (workspaceContainer: string): string =>
  `${workspaceContainer}-proxy-egress`;

/** sealant's subnet pool, by network name (the same pool per-workspace egress networks use). */
export interface EgressProxySubnets {
  readonly allocate: (input: { readonly name: string; readonly owner: string }) => Promise<string>;
  readonly release: (name: string) => Promise<void>;
}

/** The two networks of one workspace and the proxy's fixed address on the internal one. */
export interface EgressProxyNetworks {
  readonly isolated: { readonly name: string; readonly subnet: string };
  readonly outbound: { readonly name: string; readonly subnet: string };
  readonly proxyIp: string;
}

/** The last usable IPv4 address of `subnet`: the proxy's, clear of Docker's dynamic picks. */
export const proxyAddressOf = (subnet: string): string => {
  const block = cidr(subnet);
  if (block.family !== 4 || block.prefix > 29) {
    throw new Error(`The isolated network's subnet ${subnet} is not an IPv4 /29 or larger.`);
  }
  const broadcast = block.base + (1n << BigInt(32 - block.prefix)) - 1n;
  return formatCidr({ family: 4, base: broadcast - 1n, prefix: 32 }).replace(/\/32$/, "");
};

/** The `docker create` argv of a hardened proxy, every listener on `proxyIp`. */
export const egressProxyCreateArgv = (input: {
  readonly name: string;
  readonly workspaceContainer: string;
  readonly image: string;
  readonly isolatedNetwork: string;
  readonly proxyIp: string;
  readonly controlMountArgs: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const at = (port: number) => `${input.proxyIp}:${String(port)}`;
  return [
    "create",
    "--name",
    input.name,
    "--label",
    `${EGRESS_PROXY_LABEL}=${input.workspaceContainer}`,
    "--label",
    `sealant.workspace=${input.workspaceContainer}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    `${String(EGRESS_PROXY_UID)}:${String(EGRESS_PROXY_UID)}`,
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=53",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--memory",
    "256m",
    "--pids-limit",
    "256",
    "--network",
    input.isolatedNetwork,
    "--ip",
    input.proxyIp,
    ...input.controlMountArgs,
    input.image,
    "--admin-socket",
    EGRESS_PROXY_ADMIN_SOCKET,
    "--http-proxy",
    at(EGRESS_PROXY_PORTS.httpProxy),
    "--transparent-http",
    at(EGRESS_PROXY_PORTS.transparentHttp),
    "--transparent-https",
    at(EGRESS_PROXY_PORTS.transparentHttps),
    "--transparent-tcp",
    at(EGRESS_PROXY_PORTS.transparentTcp),
    "--transparent-resource",
    at(EGRESS_PROXY_PORTS.transparentResource),
    "--dns",
    at(EGRESS_PROXY_PORTS.dns),
  ];
};

/** What a revocation did on the proxy. */
export type EgressRevocationOutcome =
  /** The proxy took it and closed every matching stream before answering. */
  | { readonly outcome: "revoked"; readonly closed: number }
  /** The proxy did not confirm it, so it was killed (confirmed not running). */
  | { readonly outcome: "killed"; readonly reason: string };

export interface EgressProxyOrchestratorOptions {
  readonly run: DockerCommandRunner;
  readonly subnets: EgressProxySubnets;
  readonly image?: string;
  /** The control directory on this host every control-plane process mounts at the same path. */
  readonly controlDir: string;
  /** `-v`/`--mount` args putting `<controlDir>/<proxy>` at `/run/sealant` in the proxy. */
  readonly controlMountArgs: (proxyName: string) => ReadonlyArray<string>;
  readonly mirrors?: ReadonlyArray<WorkspaceMirrorContainer>;
  readonly healthTimeoutMs?: number;
  /** Test seam: the admin client for a socket. */
  readonly adminClient?: (socketPath: string) => ProxyAdminClient;
}

const failureText = (error: unknown): string => {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
  if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
};
const isNoSuch = (error: unknown): boolean => /no such (container|network|object)/i.test(failureText(error));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EgressProxyOrchestrator {
  readonly #run: DockerCommandRunner;
  readonly #subnets: EgressProxySubnets;
  readonly #image: string;
  readonly #controlDir: string;
  readonly #controlMountArgs: (proxyName: string) => ReadonlyArray<string>;
  readonly #mirrors: ReadonlyArray<WorkspaceMirrorContainer>;
  readonly #healthTimeoutMs: number;
  readonly #adminClient: (socketPath: string) => ProxyAdminClient;

  public constructor(options: EgressProxyOrchestratorOptions) {
    this.#run = options.run;
    this.#subnets = options.subnets;
    this.#image = options.image ?? DEFAULT_EGRESS_PROXY_IMAGE;
    this.#controlDir = options.controlDir;
    this.#controlMountArgs = options.controlMountArgs;
    this.#mirrors = options.mirrors ?? [];
    this.#healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.#adminClient = options.adminClient ?? ((socketPath) => createProxyAdminClient(socketPath));
  }

  public get image(): string {
    return this.#image;
  }

  /** The proxy's admin socket as every control-plane process on this host reaches it. */
  public adminSocketPath(workspaceContainer: string): string {
    return joinPath(this.#controlDir, egressProxyName(workspaceContainer), "proxy-admin.sock");
  }

  public client(workspaceContainer: string): ProxyAdminClient {
    return this.#adminClient(this.adminSocketPath(workspaceContainer));
  }

  /**
   * The workspace's isolated network and the proxy's outbound one, created when missing (found
   * when a launch of the same run made them), each on the subnet the pool holds for its name.
   */
  public async prepareNetworks(workspaceContainer: string): Promise<EgressProxyNetworks> {
    const isolatedName = isolatedNetworkName(workspaceContainer);
    const outboundName = proxyEgressNetworkName(workspaceContainer);
    const isolatedSubnet = await this.#subnets.allocate({
      name: isolatedName,
      owner: workspaceContainer,
    });
    await this.#ensureNetwork(isolatedName, isolatedSubnet, [
      ...isolatedNetworkCreateArgv({
        name: isolatedName,
        subnet: isolatedSubnet,
        labels: { [ISOLATED_NETWORK_LABEL]: workspaceContainer },
      }),
    ]);
    const outboundSubnet = await this.#subnets.allocate({
      name: outboundName,
      owner: workspaceContainer,
    });
    await this.#ensureNetwork(outboundName, outboundSubnet, [
      "network",
      "create",
      "--driver",
      "bridge",
      "--ipv6=false",
      "--subnet",
      outboundSubnet,
      "--label",
      `${PROXY_EGRESS_NETWORK_LABEL}=${workspaceContainer}`,
      outboundName,
    ]);
    for (const mirror of this.#mirrors) {
      // Best effort: a mirror that is missing or already joined changes nothing.
      await this.#run("docker", [...mirrorConnectArgv(outboundName, mirror)]).catch(() => undefined);
    }
    return {
      isolated: { name: isolatedName, subnet: isolatedSubnet },
      outbound: { name: outboundName, subnet: outboundSubnet },
      proxyIp: proxyAddressOf(isolatedSubnet),
    };
  }

  async #ensureNetwork(name: string, subnet: string, createArgv: Array<string>): Promise<void> {
    const exists = await this.#run("docker", ["network", "inspect", "--format", "{{.Id}}", name]).then(
      (result) => result.stdout.trim().length > 0,
      (error: unknown) => {
        if (isNoSuch(error)) return false;
        throw new Error(`Whether the network '${name}' exists could not be told: ${failureText(error)}`);
      },
    );
    if (exists) return;
    try {
      await this.#run("docker", createArgv);
    } catch (error) {
      const madeMeanwhile = await this.#run("docker", ["network", "inspect", name]).then(
        () => true,
        () => false,
      );
      if (madeMeanwhile) return;
      await this.#subnets.release(name).catch(() => undefined);
      throw new Error(`Could not create the network '${name}' on ${subnet}: ${failureText(error)}`);
    }
  }

  /**
   * The proxy's control directory, made and handed to the proxy's user: it binds its admin socket
   * there, and the workspace never mounts it.
   */
  public async prepareControlDirectory(workspaceContainer: string): Promise<void> {
    const directory = joinPath(this.#controlDir, egressProxyName(workspaceContainer));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await chown(directory, EGRESS_PROXY_UID, EGRESS_PROXY_UID);
      await chmod(directory, 0o700);
    } catch {
      // A worker that is not root cannot give the directory away: open it to the proxy's user
      // instead. The socket itself is 0660, so only its owner and group (and root) connect.
      await chmod(directory, 0o777);
    }
  }

  /**
   * Run the proxy (create, join its outbound and reach networks, start), or adopt the one a
   * launch of the same run started, or start it again when it stopped. Then wait until it answers
   * on its admin socket: it starts closed, so nothing passes until `pushPolicy`.
   */
  public async startProxy(input: {
    readonly workspaceContainer: string;
    readonly networks: EgressProxyNetworks;
    readonly reachNetworks?: ReadonlyArray<string>;
  }): Promise<{ readonly containerId: string; readonly health: ProxyHealth }> {
    const name = egressProxyName(input.workspaceContainer);
    await this.prepareControlDirectory(input.workspaceContainer);
    let state = await this.#inspect(name);
    if (state === undefined) {
      try {
        await this.#run("docker", [
          ...egressProxyCreateArgv({
            name,
            workspaceContainer: input.workspaceContainer,
            image: this.#image,
            isolatedNetwork: input.networks.isolated.name,
            proxyIp: input.networks.proxyIp,
            controlMountArgs: this.#controlMountArgs(name),
          }),
        ]);
      } catch (error) {
        // A concurrent launch of the same run may have created it first.
        if ((await this.#inspect(name)) === undefined) {
          throw new Error(`Could not create the egress proxy '${name}': ${failureText(error)}`);
        }
      }
      state = await this.#inspect(name);
    }
    if (state === undefined) throw new Error(`The egress proxy '${name}' was not created.`);
    if (!state.running) {
      for (const network of [input.networks.outbound.name, ...(input.reachNetworks ?? [])]) {
        await this.#run("docker", ["network", "connect", network, name]).catch((error: unknown) => {
          if (!/already exists|already attached/i.test(failureText(error))) throw error;
        });
      }
      await this.#run("docker", ["start", name]);
    }
    const health = await this.awaitHealthy(input.workspaceContainer);
    return { containerId: state.id, health };
  }

  /** Poll `GET /v1/health` until the proxy answers, failing early when its container ended. */
  public async awaitHealthy(workspaceContainer: string): Promise<ProxyHealth> {
    const name = egressProxyName(workspaceContainer);
    const client = this.client(workspaceContainer);
    const deadline = Date.now() + this.#healthTimeoutMs;
    for (;;) {
      try {
        return await client.health();
      } catch (error) {
        const state = await this.#inspect(name);
        if (state !== undefined && !state.running) {
          const logs = await this.#run("docker", ["logs", "--tail", "50", name]).then(
            (result) => `${result.stdout}${result.stderr}`.trim(),
            () => "",
          );
          throw new Error(
            `The egress proxy '${name}' exited before it answered on its admin socket.${logs ? ` Logs:\n${logs}` : ""}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `The egress proxy '${name}' did not answer on its admin socket within ${String(this.#healthTimeoutMs)} ms: ${failureText(error)}`,
          );
        }
        await delay(HEALTH_POLL_MS);
      }
    }
  }

  public async pushPolicy(
    workspaceContainer: string,
    document: ProxyPolicyDocument,
  ): Promise<ProxyPolicyApplied> {
    return this.client(workspaceContainer).putPolicy(document);
  }

  public async heartbeat(
    workspaceContainer: string,
    revocationWatermark: number,
  ): Promise<ProxyHeartbeat> {
    return this.client(workspaceContainer).heartbeat(revocationWatermark);
  }

  /**
   * Revoke on the live proxy, already stored by the caller. The proxy answers only once every
   * matching stream is closed. A proxy that cannot be reached, or that fails to confirm, is killed
   * and checked not running: nothing it revoked stays reachable through it. A proxy already past
   * this watermark (409) took a later policy, built from storage, that carries this revocation.
   */
  public async revoke(
    workspaceContainer: string,
    revocation: ProxyRevokeRequest,
  ): Promise<EgressRevocationOutcome> {
    try {
      const revoked = await this.client(workspaceContainer).revoke(revocation);
      return { outcome: "revoked", closed: revoked.closed };
    } catch (error) {
      if (error instanceof ProxyAdminRefusedError && error.code === "watermark_rollback") {
        return { outcome: "revoked", closed: 0 };
      }
      const reason = failureText(error);
      await this.kill(workspaceContainer);
      return { outcome: "killed", reason };
    }
  }

  /**
   * `docker kill` the proxy, then confirm it is not running (or gone). Throws when it still runs:
   * a revocation must not be reported enforced over a proxy that may still pass traffic.
   */
  public async kill(workspaceContainer: string): Promise<void> {
    const name = egressProxyName(workspaceContainer);
    const killFailure = await this.#run("docker", ["kill", name]).then(
      () => undefined,
      (error: unknown) => error,
    );
    const state = await this.#inspect(name);
    if (state !== undefined && state.running) {
      throw new Error(
        `The egress proxy '${name}' is still running after it was killed${killFailure === undefined ? "" : ` (${failureText(killFailure)})`}.`,
      );
    }
  }

  /**
   * Park a retained executor's proxy: stopped, its container and networks kept so the workspace
   * container can start again on them for recovery (which runs without its proxy).
   */
  public async park(workspaceContainer: string): Promise<boolean> {
    const name = egressProxyName(workspaceContainer);
    const state = await this.#inspect(name);
    if (state === undefined || !state.running) return false;
    await this.#run("docker", ["stop", "-t", "5", name]);
    return true;
  }

  /** Whether the proxy container exists and runs; `undefined` when there is none. */
  public async state(
    workspaceContainer: string,
  ): Promise<{ readonly id: string; readonly running: boolean } | undefined> {
    return this.#inspect(egressProxyName(workspaceContainer));
  }

  /**
   * Remove the proxy and both its networks, then release their subnets. Every container still on
   * a network (mirrors) is disconnected first. Whatever cannot be removed fails the call, and its
   * subnet stays held so nothing is reused under it.
   */
  public async remove(workspaceContainer: string): Promise<void> {
    const name = egressProxyName(workspaceContainer);
    try {
      await this.#run("docker", ["rm", "-f", name]);
    } catch (error) {
      if (!isNoSuch(error)) {
        throw new Error(`Could not remove the egress proxy '${name}': ${failureText(error)}`);
      }
    }
    for (const network of [
      isolatedNetworkName(workspaceContainer),
      proxyEgressNetworkName(workspaceContainer),
    ]) {
      await this.#removeNetwork(network);
      await this.#subnets.release(network);
    }
  }

  async #removeNetwork(network: string): Promise<void> {
    const attached = await this.#run("docker", [
      "network",
      "inspect",
      "--format",
      "{{range .Containers}}{{.Name}}\n{{end}}",
      network,
    ]).then(
      (result) =>
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      (error: unknown) => {
        if (isNoSuch(error)) return undefined;
        throw new Error(`Whether the network '${network}' remains could not be told: ${failureText(error)}`);
      },
    );
    if (attached === undefined) return;
    for (const container of attached) {
      await this.#run("docker", ["network", "disconnect", "--force", network, container]).catch(
        () => undefined,
      );
    }
    try {
      await this.#run("docker", ["network", "rm", network]);
    } catch (error) {
      if (!isNoSuch(error)) {
        throw new Error(`Could not remove the network '${network}': ${failureText(error)}`);
      }
    }
  }

  async #inspect(name: string): Promise<{ readonly id: string; readonly running: boolean } | undefined> {
    try {
      const result = await this.#run("docker", [
        "inspect",
        "--format",
        "{{.Id}}\t{{.State.Running}}",
        name,
      ]);
      const [id = "", running = ""] = result.stdout.trim().split("\t");
      if (id.length === 0) return undefined;
      return { id, running: running === "true" };
    } catch (error) {
      if (isNoSuch(error)) return undefined;
      throw new Error(`The egress proxy '${name}' could not be inspected: ${failureText(error)}`);
    }
  }
}
