import { describe, expect, it } from "vitest";

import { cidr, cidrContains, cidrsOverlap, formatCidr, type Cidr } from "../runtime/cidr.js";
import { prohibitedEgress } from "../runtime/docker-egress.js";
import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import { instanceContainerName, RESOURCE_LABELS } from "./docker-resource-argv.js";
import { DockerResourceRuntime } from "./docker-resource-runtime.js";
import { instanceRecord } from "./resource.fixture.js";

interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly instance: string;
  /** What `docker inspect` reads: the state `docker stop` waits on. */
  status: "running" | "exited";
  exitCode: number;
  /** What `docker ps` reads: Docker's container view, rewritten only after a stop is released. */
  listed: "running" | "exited";
}

/** A `--format` template filled in for one container, from the view the command reads. */
const render = (template: string, container: FakeContainer) =>
  template
    .replaceAll("{{.ID}}", container.id)
    .replaceAll(`{{.Label "${RESOURCE_LABELS.instance}"}}`, container.instance)
    .replaceAll(`{{index .Config.Labels "${RESOURCE_LABELS.instance}"}}`, container.instance)
    .replaceAll("{{.State}}", container.listed)
    .replaceAll(
      "{{.Status}}",
      container.listed === "running" ? "Up 2 minutes" : `Exited (${String(container.exitCode)})`,
    )
    .replaceAll("{{.State.Status}}", container.status)
    .replaceAll("{{.State.ExitCode}}", String(container.exitCode));
const format = (args: ReadonlyArray<string>) => args[args.indexOf("--format") + 1] ?? "";

/**
 * A Docker whose `stop` returns before its container view catches up, as the daemon can: it wakes
 * the stop's waiter (moby daemon/monitor.go, SetStopped) before it saves the container's new state
 * to the view `ps` reads (CheckpointTo). `inspect` reads the state itself.
 */
const dockerWithStaleList = (containers: FakeContainer[]): DockerCommandRunner => {
  return async (_command, args) => {
    const [verb] = args;
    if (verb === "stop") {
      const target = containers.find((container) => container.name === args.at(-1));
      if (target !== undefined) {
        target.status = "exited";
        target.exitCode = 0;
      }
      return { stdout: "", stderr: "" };
    }
    if (verb === "ps") {
      const lines = containers.map((container) => render(format(args), container));
      return { stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
    }
    if (verb === "inspect") {
      const ids = new Set(args.slice(args.indexOf("--format") + 2));
      const lines = containers
        .filter((container) => ids.has(container.id) || ids.has(container.name))
        .map((container) => render(format(args), container));
      return { stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
};

const runtimeOver = (containers: FakeContainer[]) =>
  new DockerResourceRuntime({
    subnets: {
      allocate: () => Promise.reject(new Error("unused")),
      release: () => Promise.resolve(),
    },
    commandRunner: dockerWithStaleList(containers),
  });

describe("DockerResourceRuntime.observe", () => {
  it("says an instance is stopped once stop returns, while Docker's container list still says running", async () => {
    const db = instanceRecord();
    const cache = instanceRecord({ uuid: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" });
    const containers: FakeContainer[] = [db, cache].map((instance, index) => ({
      id: `c0ffee${String(index)}`,
      name: instanceContainerName(instance.id),
      instance: instance.id,
      status: "running",
      exitCode: 0,
      listed: "running",
    }));
    const runtime = runtimeOver(containers);

    await runtime.stop(db);
    const observed = await runtime.observe();

    expect(observed.get(db.id)).toEqual({ running: false, exitCode: 0 });
    expect(observed.get(cache.id)).toEqual({ running: true, exitCode: null });
  });
});

interface ReachContainer {
  running: boolean;
  proxyBacked: boolean;
  /** Network name to the container's address on it. */
  readonly networks: Map<string, string>;
  /** The `prohibit` routes in its namespace. */
  routes: Array<Cidr>;
}

interface ReachNetwork {
  readonly subnet: Cidr;
  /** The host's side of the bridge, in `IPAM.Config`; none on an isolated one. */
  readonly gateway: string | undefined;
  /** An internal bridge: its endpoints name no gateway (`Gateway: ""`), as Docker answers. */
  readonly internal: boolean;
  readonly members: Set<string>;
}

const missing = (what: string) =>
  Object.assign(new Error("failed"), { stderr: `Error: No such ${what}` });

const creates = (host: { readonly calls: ReadonlyArray<ReadonlyArray<string>> }) =>
  host.calls.filter((call) => call[0] === "network" && call[1] === "create");

const hostAt = (block: Cidr, offset: number) =>
  formatCidr({ ...block, base: block.base + BigInt(offset), prefix: 32 }).replace("/32", "");

/**
 * A Docker host in memory for reach networks. It refuses a `network connect` whose subnet a
 * `prohibit` route in the container's namespace overlaps, in libnetwork's words, and runs the guard
 * image's `ip` against the namespace: `route show` prints it as busybox does, and a guard script's
 * `replace` and `del` lines change it.
 */
const reachHost = (options: { readonly refuseIsolated?: boolean } = {}) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const containers = new Map<string, ReachContainer>();
  const networks = new Map<string, ReachNetwork>();
  const released: Array<string> = [];
  let failGuard = false;
  let failConnect = false;
  const container = (name: string) => {
    const found = containers.get(name);
    if (found === undefined) throw missing(`container: ${name}`);
    return found;
  };
  const run: DockerCommandRunner = async (_command, args) => {
    calls.push(args);
    const [verb, sub] = args;
    const last = args.at(-1) ?? "";
    if (verb === "container" && sub === "inspect") {
      const found = container(last);
      if (format(args).includes("NetworkSettings")) {
        const endpoints = Object.fromEntries(
          [...found.networks].map(([name, address]) => {
            const network = networks.get(name);
            return [
              name,
              {
                NetworkID: `${name}-id`,
                IPAddress: address,
                IPPrefixLen: network?.subnet.prefix ?? 28,
                Gateway: network === undefined || network.internal ? "" : (network.gateway ?? ""),
              },
            ];
          }),
        );
        return { stdout: `${String(found.running)}\t${JSON.stringify(endpoints)}\n`, stderr: "" };
      }
      return { stdout: `${String(found.running)}\t0\t\n`, stderr: "" };
    }
    if (verb === "inspect" && format(args).includes("sealant.egress-proxy-backed")) {
      return { stdout: container(last).proxyBacked ? "true\n" : "\n", stderr: "" };
    }
    if (verb === "network" && sub === "inspect") {
      const network = networks.get(last);
      if (network === undefined) {
        throw Object.assign(new Error("failed"), {
          stderr: `Error response from daemon: network ${last} not found`,
        });
      }
      if (format(args) === "{{.Id}}") return { stdout: `${last}-id\n`, stderr: "" };
      if (format(args).includes("IPAM")) {
        return {
          stdout: `${JSON.stringify([{ Subnet: formatCidr(network.subnet), Gateway: network.gateway ?? "" }])}\n`,
          stderr: "",
        };
      }
      return { stdout: [...network.members].map((member) => `${member}\n`).join(""), stderr: "" };
    }
    if (verb === "network" && sub === "create") {
      const isolated = args.some((arg) => arg.includes("gateway_mode_ipv4=isolated"));
      if (isolated && options.refuseIsolated === true) {
        throw new Error(
          "Error response from daemon: failed to parse com.docker.network.bridge.gateway_mode_ipv4 value: isolated (unknown gateway mode isolated)",
        );
      }
      const subnet = cidr(args[args.indexOf("--subnet") + 1] ?? "");
      networks.set(last, {
        subnet,
        gateway: isolated ? undefined : hostAt(subnet, 1),
        internal: args.includes("--internal"),
        members: new Set(),
      });
      return { stdout: `${last}-id\n`, stderr: "" };
    }
    if (verb === "network" && sub === "connect") {
      const name = args.at(-2) ?? "";
      const network = networks.get(name);
      const member = container(last);
      if (network === undefined) throw missing("network");
      if (failConnect) {
        throw new Error("Error response from daemon: failed to allocate an address on the network");
      }
      if (member.networks.has(name)) {
        throw new Error(`Error response from daemon: endpoint with name ${last} already exists`);
      }
      const address = hostAt(network.subnet, 2 + network.members.size + 1);
      const route = member.routes.find((each) => cidrsOverlap(each, network.subnet));
      if (route !== undefined) {
        throw Object.assign(new Error("failed"), {
          stderr: `Error response from daemon: failed to add interface vethd2c4a1 to sandbox: error setting interface "vethd2c4a1" IP to ${address}/${String(network.subnet.prefix)}: cannot program address ${address}/${String(network.subnet.prefix)} in sandbox interface because it conflicts with existing route {Ifindex: 0 Dst: ${formatCidr(route)} Src: <nil> Gw: <nil> Flags: [] Table: 254 Realm: 0}`,
        });
      }
      member.networks.set(name, address);
      network.members.add(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "network" && sub === "disconnect") {
      const name = args.at(-2) ?? "";
      containers.get(last)?.networks.delete(name);
      networks.get(name)?.members.delete(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "network" && sub === "rm") {
      networks.delete(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "run") {
      const target = (args[args.indexOf("--network") + 1] ?? "").replace(/^container:/, "");
      const member = container(target);
      if (failGuard) throw new Error("Unable to find image 'busybox:1.37' locally");
      if (args.includes("route") && args.includes("show")) {
        const family = args.includes("-6") ? 6 : 4;
        const lines = member.routes
          .filter((route) => route.family === family)
          .map((route) => `prohibit ${formatCidr(route)} `.replace("/32 ", " "));
        return { stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      for (const match of last.matchAll(/ip -4 route (replace|del) prohibit (\S+?)(?= |\)|$)/gm)) {
        const block = cidr(match[2] ?? "");
        const present = member.routes.some((route) => formatCidr(route) === formatCidr(block));
        if (match[1] === "replace" && !present) member.routes.push(block);
        if (match[1] === "del") {
          member.routes = member.routes.filter((route) => formatCidr(route) !== formatCidr(block));
        }
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  const subnetsByName = new Map<string, string>();
  const runtime = new DockerResourceRuntime({
    subnets: {
      allocate: ({ name }) => {
        const subnet =
          subnetsByName.get(name) ?? `10.231.0.${String(32 * (subnetsByName.size + 5))}/27`;
        subnetsByName.set(name, subnet);
        return Promise.resolve(subnet);
      },
      release: (name) => {
        released.push(name);
        calls.push(["release", name]);
        subnetsByName.delete(name);
        return Promise.resolve();
      },
    },
    commandRunner: run,
  });
  /** A workspace on its own network; under per-workspace egress, with the guard's routes. */
  const workspace = (
    name: string,
    setup: {
      readonly egress?: string;
      readonly guarded?: boolean;
      readonly proxyBacked?: boolean;
    } = {},
  ) => {
    const own = cidr("10.233.4.16/28");
    const network = setup.egress ?? `${name}-egress`;
    networks.set(network, {
      subnet: own,
      gateway: hostAt(own, 1),
      internal: false,
      members: new Set([name]),
    });
    containers.set(name, {
      running: true,
      proxyBacked: setup.proxyBacked === true,
      networks: new Map([[network, hostAt(own, 2)]]),
      routes:
        setup.guarded === false
          ? [cidr("169.254.169.254/32")]
          : [
              ...prohibitedEgress({
                allowed: [],
                hostPublic: [],
                ownSubnets: [own],
                gateways: [cidr(hostAt(own, 1))],
                dnsServers: [],
                cloudMetadata: false,
              }),
            ],
    });
    return containers.get(name);
  };
  const guardRuns = () => calls.filter((call) => call[0] === "run");
  const connectsOf = (member: string) =>
    calls.filter(
      (call) => call[0] === "network" && call[1] === "connect" && call.at(-1) === member,
    );
  return {
    runtime,
    calls,
    containers,
    networks,
    released,
    workspace,
    guardRuns,
    connectsOf,
    failGuards: () => {
      failGuard = true;
    },
    failConnects: () => {
      failConnect = true;
    },
  };
};

const refuses = (member: ReachContainer | undefined, address: string) =>
  (member?.routes ?? []).some((route) => cidrContains(route, cidr(address)));

describe("DockerResourceRuntime reach networks", () => {
  it("makes a reach network with no host gateway, and a plain internal one where the engine refuses that", async () => {
    const isolated = "com.docker.network.bridge.gateway_mode_ipv4=isolated";
    const modern = reachHost();
    modern.workspace("sealant-run-1", { guarded: false, egress: "sealant-run-1-network" });
    await modern.runtime.attachExecutor("sealant-run-1", []);
    expect(creates(modern)).toHaveLength(1);
    expect(creates(modern)[0]).toContain(isolated);

    const older = reachHost({ refuseIsolated: true });
    older.workspace("sealant-run-1", { guarded: false, egress: "sealant-run-1-network" });
    older.workspace("sealant-run-2", { guarded: false, egress: "sealant-run-2-network" });
    await older.runtime.attachExecutor("sealant-run-1", []);
    await older.runtime.attachExecutor("sealant-run-2", []);
    // Refused once, then a plain internal network; the next one is not asked with the option again.
    expect(creates(older).map((args) => args.includes(isolated))).toEqual([true, false, false]);
    expect(creates(older).every((args) => args.includes("--internal"))).toBe(true);
  });
});

describe("DockerResourceRuntime reach of a workspace under per-workspace egress", () => {
  it("opens the workspace's own reach subnet before it connects, and nothing else", async () => {
    const host = reachHost();
    const executor = host.workspace("sealant-run-1");
    expect(refuses(executor, "10.231.0.170")).toBe(true);

    await host.runtime.attachExecutor("sealant-run-1", []);

    const subnet = host.networks.get("sealant-run-1-reach")?.subnet;
    expect(subnet === undefined ? undefined : formatCidr(subnet)).toBe("10.231.0.160/27");
    expect(executor?.networks.has("sealant-run-1-reach")).toBe(true);
    // Connected at the first attempt: opened before, not after a refusal.
    expect(host.connectsOf("sealant-run-1")).toHaveLength(1);
    for (const address of ["10.231.0.160", "10.231.0.191"]) {
      expect(refuses(executor, address), address).toBe(false);
    }
    // Every other workspace's reach subnet, and the rest of the private block, stay refused.
    for (const address of [
      "10.231.0.159",
      "10.231.0.192",
      "10.231.0.33",
      "10.224.0.1",
      "10.0.0.9",
    ]) {
      expect(refuses(executor, address), address).toBe(true);
    }
    // An isolated reach network has no gateway to refuse: no third guard container.
    expect(host.guardRuns()).toHaveLength(2);
  });

  it("opens and connects once more when Docker still refuses the route (another egress network)", async () => {
    const host = reachHost();
    const executor = host.workspace("sealant-run-1", { egress: "custom-egress" });

    await host.runtime.attachExecutor("sealant-run-1", []);

    expect(executor?.networks.has("sealant-run-1-reach")).toBe(true);
    expect(host.connectsOf("sealant-run-1")).toHaveLength(2);
    expect(refuses(executor, "10.231.0.170")).toBe(false);
    expect(refuses(executor, "10.231.0.192")).toBe(true);
  });

  it("refuses the host's side of a reach network an older engine gave a gateway", async () => {
    const host = reachHost({ refuseIsolated: true });
    const executor = host.workspace("sealant-run-1");

    await host.runtime.attachExecutor("sealant-run-1", []);

    expect(host.networks.get("sealant-run-1-reach")?.gateway).toBe("10.231.0.161");
    expect(executor?.networks.has("sealant-run-1-reach")).toBe(true);
    // Docker names it in the network's IPAM alone: the workspace's endpoint says `Gateway: ""`.
    expect(refuses(executor, "10.231.0.161")).toBe(true);
    expect(refuses(executor, "10.231.0.170")).toBe(false);
  });

  it("costs no guard container for a workspace already on its reach network, or one with no guard", async () => {
    const host = reachHost();
    host.workspace("sealant-run-1");
    await host.runtime.attachExecutor("sealant-run-1", []);
    const before = host.calls.length;
    await host.runtime.attachExecutor("sealant-run-1", []);
    const again = host.calls.slice(before);
    expect(again.some((call) => call[0] === "run")).toBe(false);
    expect(again.some((call) => call[1] === "connect")).toBe(false);

    const plain = reachHost();
    const unguarded = plain.workspace("sealant-run-2", {
      guarded: false,
      egress: "sealant-run-2-network",
    });
    await plain.runtime.attachExecutor("sealant-run-2", []);
    expect(unguarded?.networks.has("sealant-run-2-reach")).toBe(true);
    expect(plain.guardRuns()).toEqual([]);
  });

  it("connects a stopped workspace as it is, with no guard container to run in it", async () => {
    const host = reachHost();
    const parked = host.workspace("sealant-run-1");
    if (parked !== undefined) {
      parked.running = false;
      parked.routes = [];
    }
    host.failGuards();
    await host.runtime.attachExecutor("sealant-run-1", []);
    expect(parked?.networks.has("sealant-run-1-reach")).toBe(true);
    expect(host.guardRuns()).toEqual([]);
  });

  it("refuses the subnet again when the connect fails after the carve", async () => {
    const host = reachHost();
    const executor = host.workspace("sealant-run-1");
    host.failConnects();
    await expect(host.runtime.attachExecutor("sealant-run-1", [])).rejects.toThrow(
      /failed to allocate/,
    );
    expect(executor?.networks.has("sealant-run-1-reach")).toBe(false);
    for (const address of ["10.231.0.160", "10.231.0.170", "10.231.0.191"]) {
      expect(refuses(executor, address), address).toBe(true);
    }
  });

  it("connects nothing when the routes cannot be read", async () => {
    const host = reachHost();
    const executor = host.workspace("sealant-run-1");
    host.failGuards();
    await expect(host.runtime.attachExecutor("sealant-run-1", [])).rejects.toThrow(
      /Unable to find image/,
    );
    expect(executor?.networks.has("sealant-run-1-reach")).toBe(false);
    expect(refuses(executor, "10.231.0.170")).toBe(true);
  });

  it("refuses the subnet again in a running workspace before its reach network goes and the subnet is released", async () => {
    const host = reachHost();
    const executor = host.workspace("sealant-run-1");
    await host.runtime.attachExecutor("sealant-run-1", []);
    expect(refuses(executor, "10.231.0.170")).toBe(false);

    await host.runtime.detachExecutor("sealant-run-1");

    expect(host.networks.has("sealant-run-1-reach")).toBe(false);
    expect(host.released).toEqual(["sealant-run-1-reach"]);
    expect(refuses(executor, "10.231.0.170")).toBe(true);
    const restore = host.calls.findLastIndex(
      (call) => call[0] === "run" && (call.at(-1) ?? "").includes("prohibit 10.231.0.160/27"),
    );
    const removed = host.calls.findIndex((call) => call[0] === "network" && call[1] === "rm");
    const release = host.calls.findIndex((call) => call[0] === "release");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(removed);
    expect(removed).toBeLessThan(release);

    // The same subnet handed out again: the next attach opens it as before.
    await host.runtime.attachExecutor("sealant-run-1", []);
    expect(executor?.networks.has("sealant-run-1-reach")).toBe(true);
    expect(refuses(executor, "10.231.0.170")).toBe(false);
  });

  it("adds no route to a stopped or unguarded workspace when its reach network goes", async () => {
    const host = reachHost();
    const stopped = host.workspace("sealant-run-1");
    const plain = host.workspace("sealant-run-2", { guarded: false, egress: "sealant-run-2-net" });
    await host.runtime.attachExecutor("sealant-run-1", []);
    await host.runtime.attachExecutor("sealant-run-2", []);
    if (stopped !== undefined) stopped.running = false;
    const routes = { stopped: stopped?.routes.length, plain: plain?.routes.length };

    await host.runtime.detachExecutor("sealant-run-1");
    await host.runtime.detachExecutor("sealant-run-2");

    expect({ stopped: stopped?.routes.length, plain: plain?.routes.length }).toEqual(routes);
    expect(host.released).toEqual(["sealant-run-1-reach", "sealant-run-2-reach"]);
  });
});

describe("DockerResourceRuntime reach of a workspace behind its egress proxy", () => {
  it("attaches the proxy to the reach network, never the workspace itself, and runs no guard", async () => {
    const host = reachHost();
    const workspace = host.workspace("sealant-run-1", { proxyBacked: true });
    const proxy = host.workspace("sealant-run-1-proxy", { guarded: false, egress: "proxy-net" });
    await host.runtime.attachExecutor("sealant-run-1", []);
    expect(proxy?.networks.has("sealant-run-1-reach")).toBe(true);
    expect(workspace?.networks.has("sealant-run-1-reach")).toBe(false);
    expect(host.connectsOf("sealant-run-1")).toEqual([]);
    expect(host.guardRuns()).toEqual([]);

    await host.runtime.detachExecutor("sealant-run-1");
    expect(host.guardRuns()).toEqual([]);
  });

  it("attaches nothing when the workspace's proxy is not there", async () => {
    const host = reachHost();
    host.workspace("sealant-run-1", { proxyBacked: true });
    await expect(host.runtime.attachExecutor("sealant-run-1", [])).rejects.toThrow(
      /runs behind an egress proxy/,
    );
    expect(host.calls.some((call) => call[1] === "connect")).toBe(false);
  });
});
