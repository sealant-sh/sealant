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
  cidrsOverlap,
  formatCidr,
  networkOf,
  parseCidr,
  sortCidrs,
  subtractCidrs,
  type Cidr,
} from "./cidr.js";

/** Every workspace egress network is a `/28`: the workspace and the mirrors that join it. */
export const WORKSPACE_EGRESS_PREFIX = 28;

/** The label every workspace egress network carries, with the workspace container's name. */
export const WORKSPACE_EGRESS_NETWORK_LABEL = "sealant.workspace-egress";

export const workspaceEgressNetworkName = (containerName: string): string =>
  `${containerName}-egress`;

/** Private and internal ranges a workspace never reaches unless the operator opens them. */
export const PRIVATE_EGRESS_RANGES: ReadonlyArray<Cidr> = [
  cidr("10.0.0.0/8"),
  cidr("172.16.0.0/12"),
  cidr("192.168.0.0/16"),
  cidr("100.64.0.0/10"),
  cidr("169.254.0.0/16"),
  cidr("fc00::/7"),
  cidr("fe80::/10"),
];

/**
 * Addresses that hand out the host's own credentials or configuration: AWS (and most clouds')
 * instance metadata over IPv4 and IPv6, and Azure's wireserver. Opened only by the blueprint's
 * `runtime.network.cloudMetadata`, never by the operator allowlist.
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
  /** `auto`: also every public address on the Docker host's own interfaces, read at launch. */
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
 * on a malformed value and on an operator exception that would overlap sealant's own networks
 * (the workspace pool or the resource reach pool): opening those would let one workspace reach
 * another's network.
 */
export const parseDockerEgressPolicy = (input: {
  readonly workspaceSubnets: string;
  readonly reachSubnets: string;
  readonly operatorAllowedPrivateEgress: string | undefined;
  readonly hostPublicIps: string | undefined;
}): DockerEgressPolicy => {
  const pool = parseSubnetPool(input.workspaceSubnets, WORKSPACE_EGRESS_PREFIX);
  const ownRanges = [
    { range: cidr(input.workspaceSubnets), variable: "SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS" },
    { range: cidr(input.reachSubnets), variable: "SEALANT_RESOURCE_REACH_SUBNETS" },
  ] as const;
  const [workspaceRange, reachRange] = ownRanges;
  if (cidrsOverlap(workspaceRange.range, reachRange.range)) {
    throw new Error(
      `SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS (${input.workspaceSubnets}) overlaps SEALANT_RESOURCE_REACH_SUBNETS (${input.reachSubnets}): give each its own range.`,
    );
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

/** `SEALANT_HOST_PUBLIC_IPS`: addresses and blocks, and the word `auto`. */
export const parseHostPublicIps = (text: string | undefined): HostPublicAddresses => {
  if (text === undefined) return { listed: [], detect: false };
  const entries = text.split(",").map((entry) => entry.trim());
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
 * namespace, read from the `# ExtServers: [...]` line Docker writes into a container's
 * `resolv.conf`. A `host(...)` entry is forwarded from the host's namespace and needs no route; an
 * entry that is not an address is skipped.
 */
export const namespaceDnsServers = (resolvConf: string): ReadonlyArray<Cidr> => {
  const line = /^#\s*ExtServers:\s*\[(.*)\]\s*$/m.exec(resolvConf)?.[1];
  if (line === undefined) return [];
  return line
    .split(/\s+/)
    .filter((entry) => entry.length > 0 && !entry.startsWith("host("))
    .flatMap((entry) => {
      const parsed = parseCidr(entry.replace(/^\[|\]$/g, ""));
      return parsed === undefined ? [] : [parsed];
    });
};

/** The networks a container is attached to: their names and its own subnets on them. */
export interface AttachedNetworks {
  readonly names: ReadonlyArray<string>;
  readonly subnets: ReadonlyArray<Cidr>;
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
  for (const endpoint of Object.values(parsed)) {
    if (typeof endpoint !== "object" || endpoint === null) continue;
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
  return { names: Object.keys(parsed), subnets };
};

/**
 * Every block a workspace's namespace gets a `prohibit` route for: the private ranges and the
 * host's public addresses, less the operator's exceptions, the container's own networks and
 * Docker's namespace DNS servers; and the metadata addresses, less only those DNS servers (on Azure
 * the resolver is the wireserver's address) unless the blueprint opened them.
 *
 * What is left open simply has no route here: a more specific allow never depends on route order,
 * and the kernel's own connected routes keep every attached network (a reach network joined later
 * included) on-link.
 */
export const prohibitedEgress = (input: {
  readonly allowed: ReadonlyArray<Cidr>;
  readonly hostPublic: ReadonlyArray<Cidr>;
  readonly ownSubnets: ReadonlyArray<Cidr>;
  readonly dnsServers: ReadonlyArray<Cidr>;
  readonly cloudMetadata: boolean;
}): ReadonlyArray<Cidr> => {
  const metadataOpen = input.cloudMetadata ? METADATA_EGRESS_ADDRESSES : [];
  return sortCidrs([
    ...subtractCidrs(
      [...PRIVATE_EGRESS_RANGES, ...input.hostPublic],
      [...input.allowed, ...input.ownSubnets, ...input.dnsServers, ...metadataOpen],
    ),
    ...(input.cloudMetadata ? [] : subtractCidrs(METADATA_EGRESS_ADDRESSES, input.dnsServers)),
  ]);
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
