import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DockerCommandRunner } from "./docker-runtime-adapter.js";
import {
  EgressProxyOrchestrator,
  egressProxyCreateArgv,
  proxyAddressOf,
} from "./egress-proxy-orchestrator.js";
import {
  ProxyAdminRefusedError,
  ProxyAdminUnreachableError,
  type ProxyAdminClient,
} from "./proxy-admin-client.js";

/** A Docker host in memory: containers and networks, and every command it was given. */
const fakeDocker = () => {
  const calls: string[][] = [];
  const containers = new Map<string, { running: boolean; killResists?: boolean }>();
  const networks = new Map<string, Set<string>>();
  const noSuch = (what: string) =>
    Object.assign(new Error("failed"), { stderr: `Error: No such ${what}` });
  const run: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    const [verb, sub] = args;
    const last = args[args.length - 1] ?? "";
    if (verb === "network" && sub === "inspect") {
      const members = networks.get(last);
      if (members === undefined) throw noSuch("network");
      return { stdout: args.includes("{{.Id}}") ? `id-${last}\n` : [...members].join("\n"), stderr: "" };
    }
    if (verb === "network" && sub === "create") {
      networks.set(last, new Set());
      return { stdout: `id-${last}\n`, stderr: "" };
    }
    if (verb === "network" && sub === "connect") {
      networks.get(args[args.length - 2] ?? "")?.add(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "network" && sub === "disconnect") {
      networks.get(args[args.length - 2] ?? "")?.delete(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "network" && sub === "rm") {
      if ((networks.get(last)?.size ?? 0) > 0) throw new Error("has active endpoints");
      networks.delete(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "inspect") {
      const container = containers.get(last);
      if (container === undefined) throw noSuch("container");
      return { stdout: `cid-${last}\t${String(container.running)}\n`, stderr: "" };
    }
    if (verb === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      containers.set(name, { running: false });
      networks.get(args[args.indexOf("--network") + 1] ?? "")?.add(name);
      return { stdout: `cid-${name}\n`, stderr: "" };
    }
    if (verb === "start") {
      const container = containers.get(last);
      if (container === undefined) throw noSuch("container");
      container.running = true;
      return { stdout: "", stderr: "" };
    }
    if (verb === "stop" || verb === "kill") {
      const container = containers.get(last);
      if (container === undefined) throw noSuch("container");
      if (!(verb === "kill" && container.killResists === true)) container.running = false;
      return { stdout: "", stderr: "" };
    }
    if (verb === "rm") {
      containers.delete(last);
      for (const members of networks.values()) members.delete(last);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls, containers, networks };
};

const subnetPool = () => {
  const held = new Map<string, string>();
  let next = 0;
  return {
    held,
    allocate: async ({ name }: { name: string }) => {
      const existing = held.get(name);
      if (existing !== undefined) return existing;
      const subnet = `10.210.0.${String(next * 16)}/28`;
      next += 1;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name: string) => {
      held.delete(name);
    },
  };
};

const healthyClient = (overrides: Partial<ProxyAdminClient> = {}): ProxyAdminClient => ({
  health: async () => ({
    initialized: false,
    revocationWatermark: 0,
    activeConnections: 0,
    leaseRemainingMs: 0,
    leaseExpired: true,
    resyncRequired: false,
  }),
  putPolicy: async () => ({ policyHash: "h", revocationWatermark: 0, closed: 0 }),
  revoke: async (request) => ({ revocationWatermark: request.revocationWatermark, closed: 2 }),
  heartbeat: async () => ({ resyncRequired: false, leaseRemainingMs: 120_000, revocationWatermark: 0 }),
  ...overrides,
});

describe("the proxy's address and container", () => {
  it("takes the isolated subnet's last usable address", () => {
    expect(proxyAddressOf("10.210.0.16/28")).toBe("10.210.0.30");
    expect(proxyAddressOf("10.210.0.8/29")).toBe("10.210.0.14");
    expect(() => proxyAddressOf("10.210.0.0/30")).toThrow();
  });

  it("runs hardened, with every listener on its internal address and none on 0.0.0.0", () => {
    const argv = egressProxyCreateArgv({
      name: "sealant-run1-proxy",
      workspaceContainer: "sealant-run1",
      image: "egress-proxy:test",
      isolatedNetwork: "sealant-run1-isolated",
      proxyIp: "10.210.0.30",
      controlMountArgs: ["-v", "/run/sealant/sockets/sealant-run1-proxy:/run/sealant"],
    });
    const joined = argv.join(" ");
    for (const flag of [
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--user 65532:65532",
      "--sysctl net.ipv4.ip_unprivileged_port_start=53",
      "--network sealant-run1-isolated --ip 10.210.0.30",
      "-v /run/sealant/sockets/sealant-run1-proxy:/run/sealant",
      "--admin-socket /run/sealant/proxy-admin.sock",
      "--http-proxy 10.210.0.30:8080",
      "--dns 10.210.0.30:53",
      "--transparent-tcp 10.210.0.30:15444",
    ])
      expect(joined).toContain(flag);
    expect(joined).not.toContain("0.0.0.0");
    expect(argv).not.toContain("--privileged");
  });
});

describe("EgressProxyOrchestrator", () => {
  let controlDir: string;
  beforeEach(async () => {
    controlDir = await mkdtemp(join(tmpdir(), "sealant-proxy-control-"));
  });
  afterEach(async () => {
    await rm(controlDir, { recursive: true, force: true });
  });

  const orchestrator = (docker: ReturnType<typeof fakeDocker>, client = healthyClient()) => {
    const subnets = subnetPool();
    return {
      subnets,
      orchestrator: new EgressProxyOrchestrator({
        run: docker.run,
        subnets,
        image: "egress-proxy:test",
        controlDir,
        controlMountArgs: (name) => ["-v", `${join(controlDir, name)}:/run/sealant`],
        mirrors: [{ container: "npm-mirror", aliases: ["npm-mirror"] }],
        adminClient: () => client,
        healthTimeoutMs: 1_000,
      }),
    };
  };

  it("puts the workspace's network alone with its proxy, and the proxy's route out apart", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies } = orchestrator(docker);
    const networks = await proxies.prepareNetworks("sealant-run1");
    expect(networks).toEqual({
      isolated: { name: "sealant-run1-isolated", subnet: "10.210.0.0/28" },
      outbound: { name: "sealant-run1-proxy-egress", subnet: "10.210.0.16/28" },
      proxyIp: "10.210.0.14",
    });
    const create = docker.calls.find((call) => call.includes("sealant-run1-isolated") && call[1] === "create");
    expect(create).toEqual(expect.arrayContaining(["--internal", "com.docker.network.bridge.gateway_mode_ipv4=isolated"]));
    // The mirror joins the proxy's outbound network, never the workspace's.
    expect(docker.networks.get("sealant-run1-proxy-egress")?.has("npm-mirror")).toBe(true);
    expect(docker.networks.get("sealant-run1-isolated")?.has("npm-mirror")).toBe(false);
  });

  it("joins the outbound network before the proxy starts, then waits for its admin socket", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies } = orchestrator(docker);
    const networks = await proxies.prepareNetworks("sealant-run1");
    await proxies.startProxy({ workspaceContainer: "sealant-run1", networks, reachNetworks: ["sealant-run1-reach"] });
    const at = (match: (call: string[]) => boolean) => docker.calls.findIndex(match);
    const proxyJoins = (network: string) =>
      at((call) => call[1] === "connect" && call.at(-2) === network && call.at(-1) === "sealant-run1-proxy");
    const created = at((call) => call[0] === "create");
    const started = at((call) => call[0] === "start");
    expect(created).toBeGreaterThanOrEqual(0);
    expect(proxyJoins("sealant-run1-proxy-egress")).toBeGreaterThan(created);
    expect(proxyJoins("sealant-run1-reach")).toBeGreaterThan(created);
    expect(started).toBeGreaterThan(proxyJoins("sealant-run1-proxy-egress"));
    expect(started).toBeGreaterThan(proxyJoins("sealant-run1-reach"));
    expect(docker.containers.get("sealant-run1-proxy")?.running).toBe(true);
    // Its control directory is its own, and only its own.
    expect((await stat(join(controlDir, "sealant-run1-proxy"))).isDirectory()).toBe(true);
  });

  it("restarts a stopped proxy rather than making a second one", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies } = orchestrator(docker);
    const networks = await proxies.prepareNetworks("sealant-run1");
    await proxies.startProxy({ workspaceContainer: "sealant-run1", networks });
    await proxies.park("sealant-run1");
    await proxies.startProxy({ workspaceContainer: "sealant-run1", networks });
    expect(docker.calls.filter((call) => call[0] === "create")).toHaveLength(1);
    expect(docker.containers.get("sealant-run1-proxy")?.running).toBe(true);
  });

  it("fails the start, with its logs, when the proxy exits before it answers", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies } = orchestrator(
      docker,
      healthyClient({
        health: async () => {
          const proxy = docker.containers.get("sealant-run1-proxy");
          if (proxy !== undefined) proxy.running = false;
          throw new ProxyAdminUnreachableError("no socket");
        },
      }),
    );
    const networks = await proxies.prepareNetworks("sealant-run1");
    await expect(proxies.startProxy({ workspaceContainer: "sealant-run1", networks })).rejects.toThrow(
      /exited before it answered/,
    );
  });

  describe("revocation", () => {
    const started = async (client: ProxyAdminClient) => {
      const docker = fakeDocker();
      const { orchestrator: proxies } = orchestrator(docker, client);
      const networks = await proxies.prepareNetworks("sealant-run1");
      await proxies.startProxy({ workspaceContainer: "sealant-run1", networks });
      return { docker, proxies };
    };
    const request = { revocationWatermark: 4, revokeSecretIds: ["psec_1"], revokeHosts: [], revokeAll: false };

    it("is confirmed by the proxy once its streams are closed, and kills nothing", async () => {
      const { docker, proxies } = await started(healthyClient());
      expect(await proxies.revoke("sealant-run1", request)).toEqual({ outcome: "revoked", closed: 2 });
      expect(docker.calls.some((call) => call[0] === "kill")).toBe(false);
    });

    it("kills a proxy that cannot be reached, and confirms it stopped", async () => {
      const { docker, proxies } = await started(
        healthyClient({
          revoke: async () => {
            throw new ProxyAdminUnreachableError("connect ECONNREFUSED");
          },
        }),
      );
      const outcome = await proxies.revoke("sealant-run1", request);
      expect(outcome).toMatchObject({ outcome: "killed" });
      expect(docker.containers.get("sealant-run1-proxy")?.running).toBe(false);
    });

    it("kills a proxy that answered without confirming its closes", async () => {
      const { proxies } = await started(
        healthyClient({
          revoke: async () => {
            throw new ProxyAdminRefusedError(500, "close_unconfirmed", "1 connection(s) did not confirm closing");
          },
        }),
      );
      expect(await proxies.revoke("sealant-run1", request)).toMatchObject({ outcome: "killed" });
    });

    it("never reports a revocation enforced over a proxy that survives its kill", async () => {
      const { docker, proxies } = await started(
        healthyClient({
          revoke: async () => {
            throw new ProxyAdminUnreachableError("timeout");
          },
        }),
      );
      const proxy = docker.containers.get("sealant-run1-proxy");
      if (proxy !== undefined) proxy.killResists = true;
      await expect(proxies.revoke("sealant-run1", request)).rejects.toThrow(/still running/);
    });

    it("takes a proxy already past the watermark as having it (a later policy carried it)", async () => {
      const { proxies } = await started(
        healthyClient({
          revoke: async () => {
            throw new ProxyAdminRefusedError(409, "watermark_rollback", "behind");
          },
        }),
      );
      expect(await proxies.revoke("sealant-run1", request)).toEqual({ outcome: "revoked", closed: 0 });
    });
  });

  it("parks a running proxy and keeps its container and networks for recovery", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies } = orchestrator(docker);
    const networks = await proxies.prepareNetworks("sealant-run1");
    await proxies.startProxy({ workspaceContainer: "sealant-run1", networks });
    expect(await proxies.park("sealant-run1")).toBe(true);
    expect(docker.containers.get("sealant-run1-proxy")).toEqual({ running: false });
    expect(docker.networks.has("sealant-run1-isolated")).toBe(true);
    expect(await proxies.park("sealant-run1")).toBe(false);
  });

  it("removes the proxy and both networks, mirrors disconnected first, and frees the subnets", async () => {
    const docker = fakeDocker();
    const { orchestrator: proxies, subnets } = orchestrator(docker);
    const networks = await proxies.prepareNetworks("sealant-run1");
    await proxies.startProxy({ workspaceContainer: "sealant-run1", networks });
    await proxies.remove("sealant-run1");
    expect(docker.containers.has("sealant-run1-proxy")).toBe(false);
    expect(docker.networks.size).toBe(0);
    expect(subnets.held.size).toBe(0);
    // Removing again is a no-op.
    await proxies.remove("sealant-run1");
  });
});
