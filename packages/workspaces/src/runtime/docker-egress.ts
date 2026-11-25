/**
 * Per-workspace egress on the Docker runtime (`SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS`): each
 * workspace on a bridge network of its own, carved from sealant's subnet pool, and a `prohibit`
 * route in its network namespace for every private, metadata and host address it must not reach.
 *
 * Everything here is pure: the configuration's parsers (which throw, so a worker with a malformed
 * value refuses to start), the route list, the guard script and the `docker network` argv. The
 * adapter runs what these build.
 */
import { parseSubnetPool, type SubnetPool } from "@sealant/db";

import {
  cidr,
  cidrContains,
  cidrsOverlap,
  formatCidr,
  networkOf,
  parseCidr,
  sortCidrs,
  subtractCidrs,
  type Cidr,
  type IpFamily,
} from "./cidr.js";

/** Every workspace egress network is a `/28`: the workspace and the mirrors that join it. */
export const WORKSPACE_EGRESS_PREFIX = 28;

/** The label every workspace egress network carries, with the workspace container's name. */
export const WORKSPACE_EGRESS_NETWORK_LABEL = "sealant.workspace-egress";

export const workspaceEgressNetworkName = (containerName: string): string =>
  `${containerName}-egress`;

/**
 * Private and internal ranges a workspace never reaches unless the operator opens them. NAT64's
 * prefixes are here because a NAT64 gateway turns them into IPv4 addresses, private ones included.
 */
export const PRIVATE_EGRESS_RANGES: ReadonlyArray<Cidr> = [
  cidr("10.0.0.0/8"),
  cidr("172.16.0.0/12"),
  cidr("192.168.0.0/16"),
  cidr("100.64.0.0/10"),
  cidr("169.254.0.0/16"),
  cidr("fc00::/7"),
  cidr("fe80::/10"),
  cidr("64:ff9b::/96"),
  cidr("64:ff9b:1::/48"),
];

/**
 * Addresses that hand out the host's own credentials or configuration: AWS (and most clouds')
 * instance metadata over IPv4 and IPv6, and Azure's wireserver. Opened only by the blueprint's
 * `runtime.network.cloudMetadata`: never by the operator allowlist, and never because Docker's DNS
 * forwards to one of them (`metadataDnsServer`).
 */
export const METADATA_EGRESS_ADDRESSES: ReadonlyArray<Cidr> = [
  cidr("169.254.169.254/32"),
  cidr("fd00:ec2::254/128"),
  cidr("168.63.129.16/32"),
];

/** Addresses no interface of a host can call public (loopback, multicast and the like). */
const NON_PUBLIC_RANGES: ReadonlyArray<Cidr> = [
  ...PRIVATE_EGRESS_RANGES,
  cidr("0.0.0.0/8"),
  cidr("127.0.0.0/8"),
  cidr("224.0.0.0/4"),
  cidr("240.0.0.0/4"),
  cidr("::/128"),
  cidr("::1/128"),
  cidr("::ffff:0:0/96"),
  cidr("ff00::/8"),
];

/** A comma-separated list of addresses and blocks, each parsed strictly. Throws on any bad entry. */
const parseCidrList = (text: string, variable: string): ReadonlyArray<Cidr> => {
  const entries = text.split(",").map((entry) => entry.trim());
  return entries.map((entry) => {
    const parsed = parseCidr(entry);
    if (parsed === undefined) {
      throw new Error(
        `${variable} has an entry that is not an IPv4 or IPv6 address or network block: ${JSON.stringify(entry)}. Write each as 10.0.0.5, 10.0.0.0/24 or fd00::/64, with no host bits set past the prefix.`,
      );
    }
    if (parsed.family === 6 && cidrsOverlap(parsed, cidr("::ffff:0:0/96"))) {
      throw new Error(
        `${variable} names an IPv4-mapped IPv6 address (${entry}): write the IPv4 address instead.`,
      );
    }
    return parsed;
  });
};

/** The host's own public addresses: the ones written down, and whether to read the host's. */
export interface HostPublicAddresses {
  readonly listed: ReadonlyArray<Cidr>;
  /** Also every public address on the Docker host's own interfaces, read at launch. */
  readonly detect: boolean;
}

/** The parsed egress configuration a Docker adapter enforces. */
export interface DockerEgressPolicy {
  readonly pool: SubnetPool;
  /** `SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS`: the only private destinations a workspace reaches. */
  readonly allowed: ReadonlyArray<Cidr>;
  readonly hostPublic: HostPublicAddresses;
}

/**
 * The egress configuration from its variables, checked as a whole. Throws, naming the variable,
 * on a malformed value, on pools that overlap, and on an operator exception that would overlap
 * sealant's own networks (the workspace pool, or the resource reach or egress pool): opening those
 * would let one workspace reach another's network, or a resource instance's.
 */
export const parseDockerEgressPolicy = (input: {
  readonly workspaceSubnets: string;
  readonly reachSubnets: string;
  readonly resourceEgressSubnets: string;
  readonly operatorAllowedPrivateEgress: string | undefined;
  readonly hostPublicIps: string | undefined;
}): DockerEgressPolicy => {
  const pool = parseSubnetPool(input.workspaceSubnets, WORKSPACE_EGRESS_PREFIX);
  const workspaceRange = cidr(input.workspaceSubnets);
  const ownRanges = [
    { range: workspaceRange, variable: "SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS" },
    { range: cidr(input.reachSubnets), variable: "SEALANT_RESOURCE_REACH_SUBNETS" },
    { range: cidr(input.resourceEgressSubnets), variable: "SEALANT_RESOURCE_EGRESS_SUBNETS" },
  ] as const;
  for (const other of ownRanges.slice(1)) {
    if (cidrsOverlap(workspaceRange, other.range)) {
      throw new Error(
        `SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS (${input.workspaceSubnets}) overlaps ${other.variable} (${formatCidr(other.range)}): give each its own range.`,
      );
    }
  }
  const allowed =
    input.operatorAllowedPrivateEgress === undefined
      ? []
      : parseCidrList(
          input.operatorAllowedPrivateEgress,
          "SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS",
        );
  for (const entry of allowed) {
    const own = ownRanges.find(({ range }) => cidrsOverlap(entry, range));
    if (own !== undefined) {
      throw new Error(
        `SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS entry ${formatCidr(entry)} overlaps ${own.variable} (${formatCidr(own.range)}), which holds other workspaces' networks.`,
      );
    }
  }
  return { pool, allowed, hostPublic: parseHostPublicIps(input.hostPublicIps) };
};

/**
 * `SEALANT_HOST_PUBLIC_IPS`: addresses and blocks, and the word `auto`. Unset, the host's own
 * interfaces are read (`auto`): a host with a public address on an interface is covered without
 * being told. `none` alone turns that off. Listing addresses without `auto` reads nothing.
 */
export const parseHostPublicIps = (text: string | undefined): HostPublicAddresses => {
  if (text === undefined) return { listed: [], detect: true };
  const entries = text.split(",").map((entry) => entry.trim());
  if (entries.includes("none")) {
    if (entries.length > 1) {
      throw new Error("SEALANT_HOST_PUBLIC_IPS=none turns detection off and takes no other entry.");
    }
    return { listed: [], detect: false };
  }
  const detect = entries.includes("auto");
  const rest = entries.filter((entry) => entry !== "auto");
  return {
    listed: rest.length === 0 ? [] : parseCidrList(rest.join(","), "SEALANT_HOST_PUBLIC_IPS"),
    detect,
  };
};

const isPublic = (address: Cidr): boolean =>
  !NON_PUBLIC_RANGES.some((range) => cidrsOverlap(range, address));

/**
 * The public addresses in `ip -o addr show` output (busybox or iproute2), each as its own `/32` or
 * `/128`: what a packet to the host's own address would reach.
 */
export const publicHostAddresses = (ipAddrOutput: string): ReadonlyArray<Cidr> =>
  ipAddrOutput.split("\n").flatMap((line) => {
    const match = /\binet6?\s+([0-9a-fA-F:.]+)\/\d+/.exec(line);
    const parsed = match?.[1] === undefined ? undefined : parseCidr(match[1]);
    return parsed === undefined || !isPublic(parsed) ? [] : [parsed];
  });

/**
 * The upstream resolvers Docker's embedded DNS forwards to from inside the container's own network
 * namespace, read from the `# ExtServers: [...]` line Docker (25 or newer) writes into a
 * container's `resolv.conf`. A `host(...)` entry is forwarded from the host's namespace and needs
 * no route; an entry that is not an address is skipped. `undefined` when there is no such line:
 * the caller cannot tell which resolvers to keep open and must not guess.
 */
export const namespaceDnsServers = (resolvConf: string): ReadonlyArray<Cidr> | undefined => {
  const line = /^#\s*ExtServers:\s*\[(.*)\]\s*$/m.exec(resolvConf)?.[1];
  if (line === undefined) return undefined;
  return line
    .split(/\s+/)
    .filter((entry) => entry.length > 0 && !entry.startsWith("host("))
    .flatMap((entry) => {
      const parsed = parseCidr(entry.replace(/^\[|\]$/g, ""));
      return parsed === undefined ? [] : [parsed];
    });
};

/**
 * A Docker DNS server that is a metadata address. Docker's embedded resolver forwards to it from
 * inside the workspace's namespace, and a route cannot open its port 53 alone, so a workspace that
 * did not open the metadata addresses cannot be guarded on such a host (`undefined`: none is).
 */
export const metadataDnsServer = (dnsServers: ReadonlyArray<Cidr>): Cidr | undefined =>
  dnsServers.find((server) =>
    METADATA_EGRESS_ADDRESSES.some((address) => cidrsOverlap(address, server)),
  );

/**
 * The networks a container is attached to: their names and ids, its own subnets on them, and their
 * gateways (the host's side of each bridge).
 */
export interface AttachedNetworks {
  readonly names: ReadonlyArray<string>;
  /** Network name to network id, as the container's endpoint records it. */
  readonly ids: Readonly<Record<string, string>>;
  readonly subnets: ReadonlyArray<Cidr>;
  readonly gateways: ReadonlyArray<Cidr>;
  /** Network name to the gateways of the container's endpoint on it (none on an isolated bridge). */
  readonly gatewaysByNetwork: Readonly<Record<string, ReadonlyArray<Cidr>>>;
}

/**
 * A container's networks from `docker inspect --format '{{json .NetworkSettings.Networks}}'`. Its
 * own subnets are what its routes must never cover. Throws on output it cannot read, so the guard
 * fails rather than run without them.
 */
export const attachedNetworks = (networksJson: string): AttachedNetworks => {
  const parsed: unknown = JSON.parse(networksJson.trim() || "null");
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("docker inspect returned no network settings for the container.");
  }
  const subnets: Array<Cidr> = [];
  const gateways: Array<Cidr> = [];
  const ids: Record<string, string> = {};
  const gatewaysByNetwork: Record<string, ReadonlyArray<Cidr>> = {};
  for (const [name, endpoint] of Object.entries(parsed)) {
    if (typeof endpoint !== "object" || endpoint === null) continue;
    const networkId: unknown = Reflect.get(endpoint, "NetworkID");
    if (typeof networkId === "string" && networkId.length > 0) ids[name] = networkId;
    const own: Array<Cidr> = [];
    for (const key of ["Gateway", "IPv6Gateway"] as const) {
      const gateway: unknown = Reflect.get(endpoint, key);
      if (typeof gateway !== "string" || gateway.length === 0) continue;
      const parsedGateway = parseCidr(gateway);
      if (parsedGateway === undefined) {
        throw new Error(`docker inspect returned an unreadable gateway: ${gateway}`);
      }
      own.push(parsedGateway);
    }
    gateways.push(...own);
    gatewaysByNetwork[name] = own;
    for (const [addressKey, prefixKey] of [
      ["IPAddress", "IPPrefixLen"],
      ["GlobalIPv6Address", "GlobalIPv6PrefixLen"],
    ] as const) {
      const address: unknown = Reflect.get(endpoint, addressKey);
      const prefix: unknown = Reflect.get(endpoint, prefixKey);
      if (typeof address !== "string" || address.length === 0) continue;
      const network = typeof prefix === "number" ? networkOf(address, prefix) : undefined;
      if (network === undefined) {
        throw new Error(
          `docker inspect returned an unreadable address: ${address}/${String(prefix)}`,
        );
      }
      subnets.push(network);
    }
  }
  return { names: Object.keys(parsed), ids, subnets, gateways, gatewaysByNetwork };
};

/**
 * A network's subnets from `docker network inspect --format '{{json .IPAM.Config}}'`. Throws on
 * output it cannot read and on a network with none: a carve never guesses what it opens.
 */
export const ipamSubnets = (ipamJson: string): ReadonlyArray<Cidr> => {
  const parsed: unknown = JSON.parse(ipamJson.trim() || "null");
  if (!Array.isArray(parsed)) {
    throw new Error("docker network inspect returned no IPAM configuration for the network.");
  }
  const subnets = parsed.flatMap((entry: unknown) => {
    const subnet: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Subnet") : undefined;
    if (typeof subnet !== "string" || subnet.length === 0) return [];
    const block = parseCidr(subnet);
    if (block === undefined) {
      throw new Error(`docker network inspect returned an unreadable subnet: ${subnet}`);
    }
    return [block];
  });
  if (subnets.length === 0) throw new Error("docker network inspect returned no subnet.");
  return subnets;
};

/**
 * `docker run` of the guard image in a container's network namespace, printing its `family` route
 * table. No capability at all: reading routes needs none, and the container's own image (which
 * could print anything) is never run.
 */
export const routeTableArgv = (
  container: string,
  image: string,
  family: IpFamily,
): ReadonlyArray<string> => [
  "run",
  "--rm",
  "--runtime",
  "runc",
  "--network",
  `container:${container}`,
  "--cap-drop",
  "ALL",
  "--entrypoint",
  "ip",
  image,
  `-${String(family)}`,
  "route",
  "show",
];

/**
 * The destinations of the `prohibit` routes in `ip -4 route show` or `ip -6 route show` output
 * (busybox or iproute2, which print a host route without its prefix: `prohibit 169.254.169.254`).
 * Other routes are skipped. Throws on a `prohibit` route it cannot read or of the other family,
 * so a carve never runs on a table it misread.
 */
export const prohibitRoutes = (ipRouteOutput: string, family: IpFamily): ReadonlyArray<Cidr> =>
  ipRouteOutput.split("\n").flatMap((line) => {
    const [type, destination = ""] = line.trim().split(/\s+/);
    if (type !== "prohibit") return [];
    const block =
      destination === "default"
        ? cidr(family === 4 ? "0.0.0.0/0" : "::/0")
        : parseCidr(destination);
    if (block === undefined || block.family !== family) {
      throw new Error(`ip route show printed a prohibit route it could not read: ${line.trim()}`);
    }
    return [block];
  });

/** `ip route del` of one route, where a route already gone (a concurrent carve) is no error. */
const deleteProhibitRoute = (block: Cidr): string =>
  [
    `if ! out=$(ip -${String(block.family)} route del prohibit ${formatCidr(block)} 2>&1); then`,
    `  case "$out" in *"No such process"*|*"No such file"*) ;; *) echo "$out" >&2; exit 1 ;; esac`,
    "fi",
  ].join("\n");

/**
 * The guard script that opens `open` (the subnets of a network about to join) in a namespace whose
 * `prohibit` routes are `routes`, and nothing else: each route that overlaps `open` is replaced by
 * the blocks around it. Every narrower route goes in before the broad one comes out, so no address
 * outside `open` is unrefused at any moment. A route inside `open` (a subnet refused when an earlier
 * network on it went, or that network's gateway) comes out with nothing in its place. `undefined`
 * when no route overlaps `open`: there is nothing to run.
 */
export const carveProhibitRouteScript = (
  routes: ReadonlyArray<Cidr>,
  open: ReadonlyArray<Cidr>,
): string | undefined => {
  const covering = sortCidrs(
    routes.filter((route) => open.some((block) => cidrsOverlap(route, block))),
  );
  if (covering.length === 0) return undefined;
  return [
    "set -e",
    ...subtractCidrs(covering, open).map(
      (block) => `ip -${String(block.family)} route replace prohibit ${formatCidr(block)}`,
    ),
    ...covering.map(deleteProhibitRoute),
  ].join("\n");
};

/**
 * Whether a namespace's `prohibit` routes guard the private range `block` lies in, as the
 * per-workspace egress guard's do. The metadata guard's own addresses, which every workspace has,
 * do not count.
 */
export const guardsPrivateRange = (routes: ReadonlyArray<Cidr>, block: Cidr): boolean => {
  const range = PRIVATE_EGRESS_RANGES.find((each) => cidrContains(each, block));
  return (
    range !== undefined &&
    routes.some(
      (route) =>
        cidrsOverlap(route, range) &&
        !METADATA_EGRESS_ADDRESSES.some((address) => cidrsOverlap(address, route)),
    )
  );
};

/**
 * Every block a workspace's namespace gets a `prohibit` route for:
 *
 * - the private ranges and the host's public addresses, less the operator's exceptions, the
 *   container's own networks and Docker's namespace DNS servers;
 * - the gateway of each of its networks (the host's side of the bridge, where every service the
 *   host binds on all addresses answers), less the operator's exceptions. Traffic routed *through*
 *   a gateway is untouched: a route to the gateway's own address refuses only packets addressed to
 *   it, and `default via <gateway>` still forwards everything else;
 * - the metadata addresses, unless the blueprint opened them. Nothing else opens them: a DNS
 *   server on one is refused before launch (`metadataDnsServer`).
 *
 * What is left open simply has no route here: a more specific allow never depends on route order,
 * and the kernel's own connected routes keep every network attached when the guard runs on-link.
 *
 * A network joined after the guard (a resource's reach network) is not covered by that. Its subnet
 * usually sits inside one of these blocks (the workspace's `/28` taken out of `10.0.0.0/8` leaves
 * `prohibit 10.224.0.0/13`, over the whole reach pool), and Docker refuses to give an interface an
 * address that any route in the namespace overlaps ("conflicts with existing route"). Whoever
 * connects such a network splits the covering route first, opening that one subnet and nothing
 * else (`carveProhibitRouteScript`).
 */
export const prohibitedEgress = (input: {
  readonly allowed: ReadonlyArray<Cidr>;
  readonly hostPublic: ReadonlyArray<Cidr>;
  readonly ownSubnets: ReadonlyArray<Cidr>;
  readonly gateways: ReadonlyArray<Cidr>;
  readonly dnsServers: ReadonlyArray<Cidr>;
  readonly cloudMetadata: boolean;
}): ReadonlyArray<Cidr> => {
  const metadataOpen = input.cloudMetadata ? METADATA_EGRESS_ADDRESSES : [];
  return sortCidrs([
    ...subtractCidrs(
      [...PRIVATE_EGRESS_RANGES, ...input.hostPublic],
      [...input.allowed, ...input.ownSubnets, ...input.dnsServers, ...metadataOpen],
    ),
    ...subtractCidrs(input.gateways, [...input.allowed, ...metadataOpen]),
    ...(input.cloudMetadata ? [] : METADATA_EGRESS_ADDRESSES),
  ]);
};

/**
 * The entrypoint a workspace starts behind with per-workspace egress: it waits, running nothing of
 * the image, until the adapter writes `NETWORK_GATE_MARKER` once the guard's routes are in, then
 * `exec`s the image's own entrypoint and command (its arguments), which become PID 1. The marker is
 * on the container's own `/dev/shm`, a tmpfs every start makes empty, so a recovery's start waits
 * for its guard too. A gate never released ends the container (exit 70) after five minutes, so a
 * worker lost mid-launch leaves nothing running unguarded.
 */
export const NETWORK_GATE_MARKER = "/dev/shm/.sealant-network-guarded";
export const NETWORK_GATE_SCRIPT = [
  "i=0",
  `while [ ! -e ${NETWORK_GATE_MARKER} ]; do`,
  "  i=$((i + 1))",
  '  if [ "$i" -gt 1500 ]; then echo "sealant: the network guard never released this workspace" >&2; exit 70; fi',
  "  sleep 0.2",
  "done",
  'exec "$@"',
].join("\n");

/** `--entrypoint` and the arguments after the image that put `command` behind the gate. */
export const networkGateArgs = (
  command: ReadonlyArray<string>,
): { readonly entrypoint: ReadonlyArray<string>; readonly args: ReadonlyArray<string> } => ({
  entrypoint: ["--entrypoint", "/bin/sh"],
  args: ["-c", NETWORK_GATE_SCRIPT, "sealant-network-gate", ...command],
});

/**
 * The command an image runs (its entrypoint, then its command), from `docker image inspect
 * --format '{{json .Config.Entrypoint}}\t{{json .Config.Cmd}}'`. Throws on output it cannot read or
 * an image that runs nothing: the gate has nothing to hand over to.
 */
export const imageCommand = (inspectOutput: string): ReadonlyArray<string> => {
  const [entrypointJson = "", cmdJson = ""] = inspectOutput.trim().split("\t");
  const command = [...commandList(entrypointJson), ...commandList(cmdJson)];
  if (command.length === 0) throw new Error("The workspace image has no entrypoint or command.");
  return command;
};

/** One of an image config's exec-form lists (`null` is empty). */
const commandList = (json: string): ReadonlyArray<string> => {
  const parsed: unknown = JSON.parse(json || "null");
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
    throw new Error(`docker image inspect returned an unreadable command: ${json}`);
  }
  return parsed.filter((part): part is string => typeof part === "string");
};

/**
 * The guard's script: one idempotent `prohibit` route per block, so a connection to one fails at
 * once (EACCES) instead of hanging. `set -e`: a route that cannot be added fails the guard, and the
 * launch with it. A kernel without IPv6 has no `/proc/net/if_inet6` and no IPv6 route to refuse.
 */
export const prohibitRouteScript = (blocks: ReadonlyArray<Cidr>): string => {
  const v4 = blocks.filter((block) => block.family === 4);
  const v6 = blocks.filter((block) => block.family === 6);
  return [
    "set -e",
    ...v4.map((block) => `ip -4 route replace prohibit ${formatCidr(block)}`),
    ...(v6.length === 0
      ? []
      : [
          "if [ -e /proc/net/if_inet6 ]; then",
          ...v6.map((block) => `  ip -6 route replace prohibit ${formatCidr(block)}`),
          "fi",
        ]),
  ].join("\n");
};

/**
 * `docker network create` of a workspace's own egress network: a plain bridge (it is the
 * workspace's route out) on the subnet sealant allocated, labelled with the workspace.
 */
export const workspaceEgressNetworkCreateArgv = (
  name: string,
  subnet: string,
  containerName: string,
): ReadonlyArray<string> => [
  "network",
  "create",
  "--driver",
  "bridge",
  // IPv4 only, whatever the daemon's default: an IPv6 side would need its own guard and gateway.
  "--ipv6=false",
  "--subnet",
  subnet,
  "--label",
  `${WORKSPACE_EGRESS_NETWORK_LABEL}=${containerName}`,
  name,
];

/** A container that joins each workspace's egress network, under the host names it serves. */
export interface WorkspaceMirrorContainer {
  readonly container: string;
  readonly aliases: ReadonlyArray<string>;
}

const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const HOST_NAME =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * `SEALANT_DOCKER_WORKSPACE_MIRROR_CONTAINERS`: comma-separated `container[:alias[:alias...]]`,
 * such as `mend-npm-mirror:npm-mirror,mend-docker-mirror:docker-mirror`. Throws on a malformed
 * entry or a container named twice.
 */
export const parseWorkspaceMirrorContainers = (
  text: string,
): ReadonlyArray<WorkspaceMirrorContainer> => {
  const mirrors = text.split(",").map((entry) => {
    const [container = "", ...aliases] = entry.trim().split(":");
    if (!DOCKER_NAME.test(container) || aliases.some((alias) => !HOST_NAME.test(alias))) {
      throw new Error(
        `SEALANT_DOCKER_WORKSPACE_MIRROR_CONTAINERS has an entry that is not container[:alias...]: ${JSON.stringify(entry.trim())}.`,
      );
    }
    return { container, aliases };
  });
  const names = mirrors.map((mirror) => mirror.container);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new Error(`SEALANT_DOCKER_WORKSPACE_MIRROR_CONTAINERS names ${repeated} twice.`);
  }
  return mirrors;
};

/** `docker network connect` of one mirror container, under each of its aliases. */
export const mirrorConnectArgv = (
  network: string,
  mirror: WorkspaceMirrorContainer,
): ReadonlyArray<string> => [
  "network",
  "connect",
  ...mirror.aliases.flatMap((alias) => ["--alias", alias]),
  network,
  mirror.container,
];
