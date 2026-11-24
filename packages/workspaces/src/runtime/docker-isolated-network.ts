/**
 * Internal Docker bridges with no host-side gateway address (`gateway_mode_ipv4=isolated`): a
 * container on one reaches the other containers on it and nothing else, not even a service the
 * host binds on the bridge's gateway. The egress proxy topology (a workspace and its `-proxy` on
 * one such network) and the `host-vm` runtime build on these.
 */
import type { DockerCommandRunner } from "./docker-runtime-adapter.js";

export const GATEWAY_MODE_IPV4_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";
export const GATEWAY_MODE_IPV6_OPTION = "com.docker.network.bridge.gateway_mode_ipv6";

/** The first Docker Engine release whose bridge driver accepts `gateway_mode_ipv[46]=isolated`. */
export const ISOLATED_GATEWAY_MIN_ENGINE = { major: 28, minor: 0 } as const;

export interface IsolatedNetworkSpec {
  readonly name: string;
  /** IPv4 subnet, normally one carved from sealant's subnet pool. */
  readonly subnet: string;
  /** IPv6 subnet; set only where the deployment runs IPv6, and isolated the same way. */
  readonly ipv6Subnet?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** `docker network create` of an `--internal` bridge whose gateway has no address on the host. */
export const isolatedNetworkCreateArgv = (spec: IsolatedNetworkSpec): ReadonlyArray<string> => [
  "network",
  "create",
  "--driver",
  "bridge",
  "--internal",
  "--opt",
  `${GATEWAY_MODE_IPV4_OPTION}=isolated`,
  "--subnet",
  spec.subnet,
  ...(spec.ipv6Subnet === undefined
    ? []
    : ["--ipv6", "--subnet", spec.ipv6Subnet, "--opt", `${GATEWAY_MODE_IPV6_OPTION}=isolated`]),
  ...Object.entries(spec.labels ?? {}).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
  spec.name,
];

export type IsolatedGatewaySupport =
  | { readonly supported: true; readonly engineVersion: string }
  | { readonly supported: false; readonly reason: string };

const engineAtLeast = (version: string, minimum: { major: number; minor: number }): boolean => {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum.major || (major === minimum.major && minor >= minimum.minor);
};

const failureText = (error: unknown): string => {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
  if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
};

/**
 * Whether this Docker Engine makes isolated internal bridges, proved rather than assumed: the
 * engine is new enough, it creates a throwaway network with the option, and that network's bridge
 * device on the host carries no IPv4 address (read by `image` with the host's network, every
 * capability dropped). The throwaway network is always removed.
 */
export const probeIsolatedGatewaySupport = async (input: {
  readonly run: DockerCommandRunner;
  /** An image with busybox or iproute2 `ip`, such as the network guard image. */
  readonly image: string;
  readonly networkName?: string;
}): Promise<IsolatedGatewaySupport> => {
  const { run, image } = input;
  let engineVersion: string;
  try {
    engineVersion = (
      await run("docker", ["version", "--format", "{{.Server.Version}}"])
    ).stdout.trim();
  } catch (error) {
    return { supported: false, reason: `Docker Engine version unreadable: ${failureText(error)}` };
  }
  if (!engineAtLeast(engineVersion, ISOLATED_GATEWAY_MIN_ENGINE)) {
    return {
      supported: false,
      reason: `Docker Engine ${engineVersion || "unknown"} predates isolated bridge gateways (28.0 or newer).`,
    };
  }
  const name =
    input.networkName ??
    `sealant-isolation-probe-${String(process.pid)}-${Date.now().toString(36)}`;
  let networkId: string;
  try {
    networkId = (
      await run("docker", [
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        "--opt",
        `${GATEWAY_MODE_IPV4_OPTION}=isolated`,
        name,
      ])
    ).stdout.trim();
  } catch (error) {
    return {
      supported: false,
      reason: `the engine refused an isolated bridge: ${failureText(error)}`,
    };
  }
  try {
    const bridge = `br-${networkId.slice(0, 12)}`;
    const addresses = await run("docker", [
      "run",
      "--rm",
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--entrypoint",
      "ip",
      image,
      "-o",
      "-4",
      "addr",
      "show",
      "dev",
      bridge,
    ]);
    if (/\binet\s/.test(addresses.stdout)) {
      return {
        supported: false,
        reason: `the engine accepted ${GATEWAY_MODE_IPV4_OPTION}=isolated but gave the bridge ${bridge} a host address anyway.`,
      };
    }
    return { supported: true, engineVersion };
  } catch (error) {
    return {
      supported: false,
      reason: `the isolated bridge could not be inspected: ${failureText(error)}`,
    };
  } finally {
    await run("docker", ["network", "rm", networkId]).catch(() => undefined);
  }
};
