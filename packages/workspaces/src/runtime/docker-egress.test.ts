import { describe, expect, it } from "vitest";

import { cidr, cidrContains, cidrsOverlap, formatCidr, type Cidr } from "./cidr.js";
import {
  attachedNetworks,
  mirrorConnectArgv,
  namespaceDnsServers,
  parseDockerEgressPolicy,
  parseHostPublicIps,
  parseWorkspaceMirrorContainers,
  prohibitRouteScript,
  prohibitedEgress,
  publicHostAddresses,
} from "./docker-egress.js";

const policy = (overrides: {
  readonly operatorAllowedPrivateEgress?: string;
  readonly hostPublicIps?: string;
  readonly workspaceSubnets?: string;
}) =>
  parseDockerEgressPolicy({
    workspaceSubnets: overrides.workspaceSubnets ?? "10.233.0.0/16",
    reachSubnets: "10.231.0.0/16",
    operatorAllowedPrivateEgress: overrides.operatorAllowedPrivateEgress,
    hostPublicIps: overrides.hostPublicIps,
  });

const refused = (blocks: ReadonlyArray<Cidr>, address: string): boolean =>
  blocks.some((block) => cidrContains(block, cidr(address)));

const none = { allowed: [], hostPublic: [], ownSubnets: [], dnsServers: [], cloudMetadata: false };

describe("parseDockerEgressPolicy", () => {
  it("reads the operator's exceptions and the host's public addresses", () => {
    const parsed = policy({
      operatorAllowedPrivateEgress: " 192.168.10.0/24 , 100.100.1.2,fd12:3456::/48",
      hostPublicIps: "auto, 203.0.113.7",
    });
    expect(parsed.allowed.map(formatCidr)).toEqual([
      "192.168.10.0/24",
      "100.100.1.2/32",
      "fd12:3456::/48",
    ]);
    expect(parsed.hostPublic.listed.map(formatCidr)).toEqual(["203.0.113.7/32"]);
    expect(parsed.hostPublic.detect).toBe(true);
    expect(parsed.pool).toEqual({ base: 0x0ae90000, bits: 16, prefix: 28 });
  });

  it("refuses every malformed entry, naming the variable, rather than drop a protection", () => {
    for (const operatorAllowedPrivateEgress of [
      "192.168.10.0/24,",
      "192.168.10.5/24",
      "192.168.10.0/33",
      "intranet.example",
      "::ffff:10.0.0.1",
      "",
    ]) {
      expect(() => policy({ operatorAllowedPrivateEgress }), operatorAllowedPrivateEgress).toThrow(
        /SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS/,
      );
    }
    expect(() => policy({ hostPublicIps: "auto,203.0.113.300" })).toThrow(
      /SEALANT_HOST_PUBLIC_IPS/,
    );
    expect(() => policy({ workspaceSubnets: "10.233.0.5/16" })).toThrow(/host bits/);
  });

  it("refuses an exception that would open sealant's own networks, and overlapping pools", () => {
    expect(() => policy({ operatorAllowedPrivateEgress: "10.233.4.0/24" })).toThrow(
      /overlaps SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS/,
    );
    expect(() => policy({ operatorAllowedPrivateEgress: "10.0.0.0/8" })).toThrow(
      /overlaps SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS/,
    );
    expect(() => policy({ operatorAllowedPrivateEgress: "10.231.0.7" })).toThrow(
      /overlaps SEALANT_RESOURCE_REACH_SUBNETS/,
    );
    expect(() => policy({ workspaceSubnets: "10.231.128.0/17" })).toThrow(
      /overlaps SEALANT_RESOURCE_REACH_SUBNETS/,
    );
  });

  it("detects host addresses only when asked", () => {
    expect(parseHostPublicIps(undefined)).toEqual({ listed: [], detect: false });
    expect(parseHostPublicIps("auto")).toEqual({ listed: [], detect: true });
  });
});

describe("prohibitedEgress", () => {
  it("refuses every private, Tailscale, link-local, metadata and wireserver address by default", () => {
    expect(prohibitedEgress(none).map(formatCidr)).toEqual([
      "10.0.0.0/8",
      "100.64.0.0/10",
      "168.63.129.16/32",
      "169.254.0.0/16",
      "169.254.169.254/32",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
      "fd00:ec2::254/128",
      "fe80::/10",
    ]);
  });

  it("opens the operator's exceptions, the container's own networks and Docker's namespace DNS servers", () => {
    const blocks = prohibitedEgress({
      ...none,
      allowed: [cidr("192.168.10.0/24")],
      ownSubnets: [cidr("10.233.0.16/28"), cidr("172.18.0.0/16")],
      dnsServers: [cidr("10.0.0.2")],
      hostPublic: [cidr("203.0.113.7")],
    });
    for (const open of [
      "192.168.10.1",
      "10.233.0.17",
      "10.233.0.30",
      "172.18.5.5",
      "10.0.0.2",
      "8.8.8.8",
    ]) {
      expect(refused(blocks, open), open).toBe(false);
    }
    for (const closed of [
      "192.168.11.1",
      "10.233.0.33",
      "10.0.0.3",
      "172.19.0.1",
      "203.0.113.7",
      "100.100.100.100",
      "169.254.169.254",
    ]) {
      expect(refused(blocks, closed), closed).toBe(true);
    }
  });

  it("keeps a narrow exception from cutting into the container's own network", () => {
    // Subtracting a /32 inside 172.16.0.0/12 leaves blocks far more specific than the container's
    // /16: without the own-network carve-out one of them would shadow its connected route.
    const blocks = prohibitedEgress({
      ...none,
      allowed: [cidr("172.18.5.5")],
      ownSubnets: [cidr("172.18.0.0/16")],
    });
    expect(blocks.some((block) => cidrsOverlap(block, cidr("172.18.0.0/16")))).toBe(false);
  });

  it("opens the metadata addresses only for a blueprint that asked, and the rest of link-local never", () => {
    const blocks = prohibitedEgress({ ...none, cloudMetadata: true });
    for (const open of ["169.254.169.254", "fd00:ec2::254", "168.63.129.16"]) {
      expect(refused(blocks, open), open).toBe(false);
    }
    for (const closed of ["169.254.169.253", "169.254.0.1", "fd00:ec2::253", "10.1.1.1"]) {
      expect(refused(blocks, closed), closed).toBe(true);
    }
    // An operator exception never opens them: only the blueprint does.
    const operator = prohibitedEgress({ ...none, allowed: [cidr("169.254.0.0/16")] });
    expect(refused(operator, "169.254.169.254")).toBe(true);
    expect(refused(operator, "169.254.0.1")).toBe(false);
  });

  it("keeps the resolver reachable when Docker forwards to the wireserver (Azure DNS)", () => {
    const blocks = prohibitedEgress({ ...none, dnsServers: [cidr("168.63.129.16")] });
    expect(refused(blocks, "168.63.129.16")).toBe(false);
    expect(refused(blocks, "169.254.169.254")).toBe(true);
  });

  it("never refuses an opened address and always refuses a closed one (seeded rule)", () => {
    let state = 0x1ce;
    const random = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };
    const octet = () => Math.floor(random() * 256);
    const privateAddress = () =>
      [
        `10.${String(octet())}.${String(octet())}.${String(octet())}`,
        `172.${String(16 + Math.floor(random() * 16))}.${String(octet())}.${String(octet())}`,
        `192.168.${String(octet())}.${String(octet())}`,
      ][Math.floor(random() * 3)] ?? "10.0.0.1";
    for (let round = 0; round < 200; round += 1) {
      const allowed = Array.from({ length: Math.floor(random() * 3) }, () =>
        cidr(`${privateAddress()}`),
      );
      const own = cidr(privateAddress());
      const blocks = prohibitedEgress({ ...none, allowed, ownSubnets: [own] });
      for (const open of [...allowed, own]) {
        expect(
          blocks.some((block) => cidrsOverlap(block, open)),
          formatCidr(open),
        ).toBe(false);
      }
      const probe = cidr(privateAddress());
      const opened = [...allowed, own].some((open) => cidrContains(open, probe));
      expect(refused(blocks, formatCidr(probe).replace("/32", "")), formatCidr(probe)).toBe(
        !opened,
      );
      expect(refused(blocks, "169.254.169.254")).toBe(true);
    }
  });
});

describe("the guard's inputs and script", () => {
  it("writes one idempotent prohibit route per block, IPv6 only where the kernel has it", () => {
    expect(prohibitRouteScript([cidr("10.0.0.0/8"), cidr("fc00::/7")])).toBe(
      [
        "set -e",
        "ip -4 route replace prohibit 10.0.0.0/8",
        "if [ -e /proc/net/if_inet6 ]; then",
        "  ip -6 route replace prohibit fc00::/7",
        "fi",
      ].join("\n"),
    );
  });

  it("reads the resolvers Docker forwards to from the namespace, not the host's", () => {
    const conf = [
      "nameserver 127.0.0.11",
      "# Based on host file: '/etc/resolv.conf' (internal resolver)",
      "# ExtServers: [192.168.1.1 host(127.0.0.53) fd00::53 [2001:db8::1]]",
      "# Overrides: []",
    ].join("\n");
    expect(namespaceDnsServers(conf).map(formatCidr)).toEqual([
      "192.168.1.1/32",
      "fd00::53/128",
      "2001:db8::1/128",
    ]);
    expect(namespaceDnsServers("nameserver 127.0.0.11\n")).toEqual([]);
  });

  it("finds the host's public addresses among its interfaces", () => {
    const output = [
      "1: lo    inet 127.0.0.1/8 scope host lo",
      "2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0",
      "2: eth0    inet 10.0.0.4/24 scope global eth0",
      "3: tailscale0    inet 100.101.102.103/32 scope global tailscale0",
      "2: eth0    inet6 2001:db8::7/64 scope global",
      "2: eth0    inet6 fd00::7/64 scope global",
    ].join("\n");
    expect(publicHostAddresses(output).map(formatCidr)).toEqual([
      "203.0.113.7/32",
      "2001:db8::7/128",
    ]);
  });

  it("reads a container's own networks, and refuses settings it cannot read", () => {
    const networks = attachedNetworks(
      JSON.stringify({
        "sealant-run-egress": { IPAddress: "10.233.0.2", IPPrefixLen: 28, GlobalIPv6Address: "" },
        "sealant-run-network": {
          IPAddress: "172.18.0.3",
          IPPrefixLen: 16,
          GlobalIPv6Address: "fd00:1::3",
          GlobalIPv6PrefixLen: 64,
        },
      }),
    );
    expect(networks.names).toEqual(["sealant-run-egress", "sealant-run-network"]);
    expect(networks.subnets.map(formatCidr)).toEqual([
      "10.233.0.0/28",
      "172.18.0.0/16",
      "fd00:1::/64",
    ]);
    expect(() => attachedNetworks("null")).toThrow();
    expect(() => attachedNetworks('{"n":{"IPAddress":"10.0.0.1","IPPrefixLen":"x"}}')).toThrow();
  });

  it("joins each mirror under its host names, and refuses a malformed or repeated entry", () => {
    const mirrors = parseWorkspaceMirrorContainers(
      "mend-npm-mirror:npm-mirror,mend-docker-mirror:docker-mirror:registry.local",
    );
    expect(
      mirrorConnectArgv("sealant-run-egress", mirrors[1] ?? { container: "", aliases: [] }),
    ).toEqual([
      "network",
      "connect",
      "--alias",
      "docker-mirror",
      "--alias",
      "registry.local",
      "sealant-run-egress",
      "mend-docker-mirror",
    ]);
    for (const text of ["mirror; rm -rf /", "mirror:bad_alias!", "a:x,a:y", "mirror,"]) {
      expect(() => parseWorkspaceMirrorContainers(text), text).toThrow(
        /SEALANT_DOCKER_WORKSPACE_MIRROR_CONTAINERS/,
      );
    }
  });
});
