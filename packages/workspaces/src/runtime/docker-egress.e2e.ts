/**
 * Per-workspace egress against a real Docker daemon: each workspace on a network of its own carved
 * from the pool, never able to reach another; private, Tailscale, metadata and wireserver
 * addresses refused at once from the workspace and its Docker service; the operator's exception,
 * the mirror and the public internet still reached; and nothing of a removed workspace left.
 *
 * The private target is real: a server published on the default bridge's gateway address, which a
 * container on any other bridge reaches through Docker's own DNAT (a service published on a LAN
 * address is the same shape). Also here: an isolated internal bridge (`gateway_mode_ipv4=isolated`)
 * whose containers reach each other and nothing on the host.
 *
 * Also a resource instance attached to a running workspace after its guard ran, on a reach subnet
 * inside one of the guard's `prohibit` routes (SLNT-1342): reached by name, with nothing else of
 * the route opened, and the subnet refused again when the reach network goes.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ResourceInstanceId } from "@sealant/api-contracts";
import { resourceInstanceSpecDigest, type ResourceInstanceRecord } from "@sealant/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  egressNetworkName,
  instanceContainerName,
  reachNetworkName,
} from "../resources/docker-resource-argv.js";
import {
  DockerResourceRuntime,
  type ResourceSubnets,
} from "../resources/docker-resource-runtime.js";
import { desiredAttachments } from "../resources/reach.js";
import { instanceRecord, linkedExecutor, postgresSpec } from "../resources/resource.fixture.js";
import { cidr, cidrContains, formatCidr } from "./cidr.js";
import { parseDockerEgressPolicy, prohibitRoutes } from "./docker-egress.js";
import {
  isolatedNetworkCreateArgv,
  probeIsolatedGatewaySupport,
} from "./docker-isolated-network.js";
import {
  DEFAULT_NETWORK_GUARD_IMAGE,
  DockerRuntimeAdapter,
  type DockerCommandRunner,
  type DockerWorkspaceSubnets,
} from "./docker-runtime-adapter.js";
import { inspectLocalPublishedImage } from "./local-image.e2e-support.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);
const docker: DockerCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** A command's output, failed or not, and how long it took. */
const attempt = async (
  args: readonly string[],
): Promise<{ ok: boolean; output: string; ms: number }> => {
  const started = Date.now();
  try {
    const result = await docker("docker", [...args]);
    return { ok: true, output: result.stdout + result.stderr, ms: Date.now() - started };
  } catch (error) {
    const output =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : String(error);
    return { ok: false, output, ms: Date.now() - started };
  }
};

const PERSON_UID = "40001";
const tag = `${process.pid}`;
const WORKSPACE_SUBNETS = "10.249.0.0/16";
/** Each run carves its own /24 of the pool, so a run killed before its cleanup never blocks the next. */
const RUN_OCTET = process.pid % 250;
const PUBLISHED_PORT = String(18_000 + (process.pid % 1000));
/** A port the host serves on every address, so on each bridge's gateway too. */
const HOST_PORT = String(19_000 + (process.pid % 1000));
/** A public address the operator lists as the host's own (TEST-NET-2, routed nowhere). */
const LISTED_HOST_ADDRESS = "198.51.100.7";
const mirror = `sealant-egress-e2e-mirror-${tag}`;
const published = `sealant-egress-e2e-published-${tag}`;
const hostService = `sealant-egress-e2e-host-${tag}`;

/**
 * sealant's resource subnet table, in memory: reach networks from the reach pool, a resource's
 * egress network from its own, and a released subnet handed out again first, as the repository
 * does.
 */
const memoryResourceSubnets = (): ResourceSubnets & { readonly held: Map<string, string> } => {
  const held = new Map<string, string>();
  const pools = { reach: "10.248", egress: "10.247", caller: "10.246" } as const;
  return {
    held,
    allocate: async ({ name, kind }) => {
      const existing = held.get(name);
      if (existing !== undefined) return existing;
      const taken = new Set(held.values());
      for (let index = 0; index < 8; index += 1) {
        const subnet = `${pools[kind]}.${String(RUN_OCTET)}.${String(index * 32)}/27`;
        if (taken.has(subnet)) continue;
        held.set(name, subnet);
        return subnet;
      }
      throw new Error("the e2e resource subnet pool is full");
    },
    release: async (name) => {
      held.delete(name);
    },
  };
};

/** sealant's subnet table, in memory, carving the pool the way the repository does. */
const memorySubnets = () => {
  const held = new Map<string, string>();
  const released: string[] = [];
  let next = 0;
  const subnets: DockerWorkspaceSubnets = {
    allocate: async ({ name }) => {
      const subnet = held.get(name) ?? `10.249.${String(RUN_OCTET)}.${String(next * 16)}/28`;
      if (!held.has(name)) next += 1;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name) => {
      held.delete(name);
      released.push(name);
    },
  };
  return { subnets, held, released };
};

describe("per-workspace Docker egress", () => {
  let fixtureDir: string | undefined;
  let image: string | undefined;
  let gateway = "172.17.0.1";
  const table = memorySubnets();
  let strict: DockerRuntimeAdapter;
  let allowed: DockerRuntimeAdapter;
  const launched: Array<{
    readonly adapter: DockerRuntimeAdapter;
    readonly resourceId: string;
    readonly reference: string;
  }> = [];
  const resourceTable = memoryResourceSubnets();
  const resources = new DockerResourceRuntime({
    subnets: resourceTable,
    commandRunner: docker,
    readyTimeoutMs: 60_000,
  });
  const probeSpec = postgresSpec({
    alias: "probe",
    image: DEFAULT_NETWORK_GUARD_IMAGE,
    command: [
      "sh",
      "-c",
      "mkdir -p /www && echo resource-ok > /www/index.html && exec httpd -f -p 8080 -h /www",
    ],
    env: {},
    volumes: [],
    ready: { kind: "tcp", port: 8080 },
  });
  const probeUuid = randomUUID();
  const database: ResourceInstanceRecord = {
    ...instanceRecord({ uuid: probeUuid, spec: probeSpec }),
    id: ResourceInstanceId.make(`rin:${probeUuid}`),
    specDigest: resourceInstanceSpecDigest(probeSpec),
  };
  let a = { id: "missing", name: "missing" };
  let b = { id: "missing", name: "missing" };
  let c = { id: "missing", name: "missing" };

  const launch = async (
    adapter: DockerRuntimeAdapter,
    runId: string,
    dockerService: boolean,
  ): Promise<{ id: string; name: string }> => {
    if (fixtureDir === undefined || image === undefined) throw new Error("no fixture");
    const result = await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        runId,
        blueprint: {
          version: "1",
          sources: { workspace: { kind: "mount", hostPath: fixtureDir }, inputs: [], mounts: [] },
          harness: { id: "opencode" },
          access: { ssh: { enabled: false, listenPort: 2222 } },
          tooling: { packages: [], services: { docker: { enabled: dockerService } } },
          lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
          runtime: {
            env: {},
            credentialRefs: [],
            workspaceRoot: "/workspace",
            workingDirectory: "/workspace/repo",
            persistence: "ephemeral",
            ociRuntime: "runc",
            network: { outbound: true, cloudMetadata: false },
          },
          target: {
            os: { family: "arch", mode: "prefer" },
            runtime: { family: "docker", mode: "require" },
          },
        },
        publication: {
          kind: "oci",
          publicationId: "fixture-publication",
          image: await inspectLocalPublishedImage({
            repository: "sealant/egress-fixture",
            tag: "e2e",
            reference: image,
          }),
          evidence: {},
        },
      }),
    );
    launched.push({ adapter, resourceId: result.resourceId, reference: result.reference });
    return { id: result.resourceId, name: result.reference };
  };

  const egressAddress = async (workspace: { id: string; name: string }): Promise<string> =>
    (
      await docker("docker", [
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${workspace.name}-egress").IPAddress}}`,
        workspace.id,
      ])
    ).stdout.trim();

  const fetch = (workspace: string, url: string, user = "0") =>
    attempt(["exec", "-u", user, workspace, "wget", "-T", "10", "-qO-", url]);

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "sealant-egress-"));
    image = `sealant-egress-fixture:${tag}`;
    await writeFile(
      join(fixtureDir, "Dockerfile"),
      [
        "FROM docker:27.5.1-cli",
        `RUN mkdir -p /workspace/repo && adduser -D -u ${PERSON_UID} person`,
        'ENTRYPOINT ["sleep"]',
        'CMD ["infinity"]',
        "",
      ].join("\n"),
    );
    await docker("docker", ["build", "-t", image, fixtureDir]);
    gateway = (
      await docker("docker", [
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{(index .IPAM.Config 0).Gateway}}",
      ])
    ).stdout.trim();
    const serve = (name: string, extra: string[], body: string) =>
      docker("docker", [
        "run",
        "-d",
        "--name",
        name,
        ...extra,
        "busybox:1.37",
        "sh",
        "-c",
        `mkdir -p /www && echo ${body} > /www/index.html && exec httpd -f -p 80 -h /www`,
      ]);
    await serve(mirror, [], "mirror-ok");
    await serve(published, ["-p", `${gateway}:${PUBLISHED_PORT}:80`], "published-ok");
    await serve(hostService, ["-p", `${HOST_PORT}:80`], "host-ok");

    const common = {
      commandRunner: docker,
      runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
      verifyRunning: false,
      mountAllowedStoreRoots: fixtureDir,
      stopGraceSeconds: 1,
    };
    const policy = (operatorAllowedPrivateEgress?: string, hostPublicIps?: string) =>
      parseDockerEgressPolicy({
        workspaceSubnets: WORKSPACE_SUBNETS,
        reachSubnets: "10.248.0.0/16",
        resourceEgressSubnets: "10.247.0.0/16",
        operatorAllowedPrivateEgress,
        hostPublicIps,
      });
    const mirrors = [{ container: mirror, aliases: ["npm-mirror"] }];
    strict = new DockerRuntimeAdapter({
      ...common,
      egress: {
        policy: policy(undefined, `auto,${LISTED_HOST_ADDRESS}`),
        subnets: table.subnets,
        mirrors,
      },
    });
    allowed = new DockerRuntimeAdapter({
      ...common,
      egress: { policy: policy(`${gateway}/32`), subnets: table.subnets, mirrors },
    });
    a = await launch(strict, `egress-a-${tag}`, true);
    b = await launch(strict, `egress-b-${tag}`, false);
    c = await launch(allowed, `egress-c-${tag}`, false);
  }, 300_000);

  afterAll(async () => {
    for (const { adapter, resourceId, reference } of launched) {
      await adapter.stop({ resourceId, reference }).catch((error: unknown) => {
        console.warn("e2e cleanup could not stop a workspace", { reference, error });
      });
    }
    for (const name of [mirror, published, hostService, instanceContainerName(database.id)]) {
      await docker("docker", ["rm", "-f", name]).catch(() => undefined);
    }
    for (const network of [
      reachNetworkName(a.name),
      reachNetworkName(b.name),
      egressNetworkName(database.id),
    ]) {
      await docker("docker", ["network", "rm", network]).catch(() => undefined);
    }
    if (image !== undefined) {
      await docker("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    }
    if (fixtureDir !== undefined) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("puts each workspace on a network of its own from the pool, with the mirror on it", async () => {
    const networks = (
      await docker("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", b.id])
    ).stdout;
    const parsed: unknown = JSON.parse(networks);
    expect(typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : []).toEqual([
      `${b.name}-egress`,
    ]);
    const subnet = (
      await docker("docker", [
        "network",
        "inspect",
        "--format",
        "{{(index .IPAM.Config 0).Subnet}}",
        `${b.name}-egress`,
      ])
    ).stdout.trim();
    expect(subnet).toBe(table.held.get(`${b.name}-egress`));
    expect(subnet).toMatch(/^10\.249\.\d+\.\d+\/28$/);
    const capDrop = (
      await docker("docker", ["inspect", "--format", "{{json .HostConfig.CapDrop}}", b.id])
    ).stdout;
    expect(capDrop).toContain("NET_RAW");

    for (const workspace of [a, b, c]) {
      const reply = await fetch(workspace.id, "http://npm-mirror/");
      expect(reply.output.trim(), workspace.name).toBe("mirror-ok");
    }
  });

  it("never lets one workspace reach another", async () => {
    const [toB, toA] = [await egressAddress(b), await egressAddress(a)];
    for (const [from, address] of [
      [a.id, toB],
      [b.id, toA],
      [c.id, toA],
    ] as const) {
      const probe = await fetch(from, `http://${address}/`);
      expect(probe.ok).toBe(false);
      expect(probe.output).toContain("Permission denied");
      expect(probe.ms).toBeLessThan(5_000);
    }
  });

  it("refuses private, Tailscale, metadata and wireserver addresses at once, for root and a person", async () => {
    for (const user of ["0", PERSON_UID]) {
      for (const address of [
        "10.20.30.40",
        "172.20.0.5",
        "192.168.77.1",
        "100.100.100.100",
        "169.254.169.254",
        "168.63.129.16",
        `${gateway}:${PUBLISHED_PORT}`,
      ]) {
        // From b, on its egress network alone: a's Docker service network is a private /16 of
        // Docker's default pool, which may hold one of these addresses and is a's own.
        const probe = await fetch(b.id, `http://${address}/`, user);
        expect(probe.ok, `${user} → ${address}`).toBe(false);
        expect(probe.output, `${user} → ${address}`).toContain("Permission denied");
        expect(probe.ms, `${user} → ${address}`).toBeLessThan(5_000);
      }
    }
    const removal = await attempt([
      "exec",
      b.id,
      "ip",
      "route",
      "del",
      "prohibit",
      "169.254.169.254/32",
    ]);
    expect(removal.output).toContain("Operation not permitted");
  });

  it("refuses the host behind its own network's gateway, and still routes out through it", async () => {
    const own = (
      await docker("docker", [
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${b.name}-egress").Gateway}}`,
        b.id,
      ])
    ).stdout.trim();
    expect(own).toMatch(/^10\.249\./);
    // Without the guard this answers: a port the host serves on every address is on the gateway.
    const probe = await fetch(b.id, `http://${own}:${HOST_PORT}/`);
    expect(probe.ok).toBe(false);
    expect(probe.output).toContain("Permission denied");
    expect(probe.ms).toBeLessThan(5_000);

    expect((await fetch(b.id, "http://npm-mirror/")).output.trim()).toBe("mirror-ok");
    const resolved = await attempt(["exec", b.id, "nslookup", "mirror.gcr.io"]);
    expect(resolved.ok, resolved.output).toBe(true);
    const outbound = await attempt([
      "exec",
      b.id,
      "wget",
      "-T",
      "20",
      "-qO-",
      "http://mirror.gcr.io/v2/",
    ]);
    expect(outbound.output).not.toContain("Permission denied");
    expect(outbound.output).not.toContain("bad address");
  });

  it("refuses the host's own public addresses, and only those", async () => {
    const listed = await fetch(b.id, `http://${LISTED_HOST_ADDRESS}/`);
    expect(listed.output).toContain("Permission denied");
    expect(listed.ms).toBeLessThan(5_000);
    const neighbour = await attempt([
      "exec",
      b.id,
      "wget",
      "-T",
      "3",
      "-qO-",
      "http://198.51.100.8/",
    ]);
    expect(neighbour.ok).toBe(false);
    expect(neighbour.output).not.toContain("Permission denied");
  });

  it("starts the image's own command only after the guard, as PID 1", async () => {
    const command = await docker("docker", ["exec", b.id, "cat", "/proc/1/cmdline"]);
    expect(command.stdout.split("\0").filter((part) => part.length > 0)).toEqual([
      "sleep",
      "infinity",
    ]);
    const marker = await attempt(["exec", b.id, "test", "-e", "/dev/shm/.sealant-network-guarded"]);
    expect(marker.ok).toBe(true);
  });

  it("gives the workspace's Docker service the same routes", async () => {
    const routes = await docker("docker", [
      "run",
      "--rm",
      "--network",
      `container:${a.name}-docker`,
      DEFAULT_NETWORK_GUARD_IMAGE,
      "ip",
      "route",
      "show",
    ]);
    expect(routes.stdout).toContain("prohibit 169.254.169.254");
    expect(routes.stdout).toContain("prohibit 100.64.0.0/10");
    expect(routes.stdout).toContain("prohibit 168.63.129.16");
  });

  it("reaches the operator's exception from a workspace under it, and the public internet", async () => {
    const reply = await fetch(c.id, `http://${gateway}:${PUBLISHED_PORT}/`);
    expect(reply.output.trim()).toBe("published-ok");

    const resolved = await attempt(["exec", a.id, "nslookup", "mirror.gcr.io"]);
    expect(resolved.ok, resolved.output).toBe(true);
    const outbound = await attempt([
      "exec",
      a.id,
      "wget",
      "-T",
      "20",
      "-qO-",
      "http://mirror.gcr.io/v2/",
    ]);
    expect(outbound.output).not.toContain("Permission denied");
    expect(outbound.output).not.toContain("bad address");
  });

  describe("a resource attached after the guard ran (SLNT-1342)", () => {
    /** The workspace's IPv4 `prohibit` routes, read with the guard image. */
    const routesOf = async (workspace: { id: string }) =>
      prohibitRoutes(
        (
          await docker("docker", [
            "run",
            "--rm",
            "--network",
            `container:${workspace.id}`,
            DEFAULT_NETWORK_GUARD_IMAGE,
            "ip",
            "-4",
            "route",
            "show",
          ])
        ).stdout,
        4,
      );
    const addressOn = async (container: string, network: string) =>
      (
        await docker("docker", [
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          container,
        ])
      ).stdout.trim();
    const attachments = () => desiredAttachments([linkedExecutor(a.name, "w1")], [database]);
    const refusedAtOnce = async (from: string, url: string) => {
      const reply = await fetch(from, url);
      expect(reply.ok, url).toBe(false);
      expect(reply.output, url).toContain("Permission denied");
      expect(reply.ms, url).toBeLessThan(5_000);
    };

    it("joins a database-like resource to a running guarded workspace on a subnet its routes covered", async () => {
      const before = await routesOf(a);
      const started = await resources.up(database, attachments());
      expect(started.state, JSON.stringify(started.state)).toMatchObject({ kind: "running" });
      const subnet = resourceTable.held.get(reachNetworkName(a.name)) ?? "";
      expect(subnet).toMatch(/^10\.248\./);
      // The guard had refused the whole reach pool, the subnet included, before the attach.
      expect(before.some((route) => cidrContains(route, cidr(subnet)))).toBe(true);
      const reply = await fetch(a.id, "http://probe:8080/");
      expect(reply.output.trim()).toBe("resource-ok");
    });

    it("still refuses another workspace's reach subnet and egress, private, metadata and its own gateway", async () => {
      await resources.attachExecutor(b.name, []);
      const bReach = await addressOn(b.id, reachNetworkName(b.name));
      expect(bReach).toMatch(/^10\.248\./);
      const ownGateway = (
        await docker("docker", [
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${a.name}-egress").Gateway}}`,
          a.id,
        ])
      ).stdout.trim();
      for (const target of [
        `http://${bReach}:8080/`,
        `http://${await egressAddress(b)}/`,
        "http://10.20.30.40/",
        "http://10.248.255.1/",
        "http://169.254.169.254/",
        `http://${ownGateway}:${HOST_PORT}/`,
      ]) {
        await refusedAtOnce(a.id, target);
      }
      // b is on a reach network of its own, which the resource is not on.
      const probeAddress = await addressOn(
        instanceContainerName(database.id),
        reachNetworkName(a.name),
      );
      await refusedAtOnce(b.id, `http://${probeAddress}:8080/`);
    });

    it("refuses the subnet again in the running workspace once its reach network goes, and opens it on the next attach", async () => {
      const subnet = resourceTable.held.get(reachNetworkName(a.name)) ?? "";
      const probeAddress = await addressOn(
        instanceContainerName(database.id),
        reachNetworkName(a.name),
      );
      await resources.detachExecutor(a.name);
      expect(resourceTable.held.has(reachNetworkName(a.name))).toBe(false);
      expect((await routesOf(a)).map(formatCidr)).toContain(subnet);
      await refusedAtOnce(a.id, `http://${probeAddress}:8080/`);

      // The released subnet is handed out again first: the next attach opens that route alone.
      await resources.attachExecutor(a.name, attachments());
      expect(resourceTable.held.get(reachNetworkName(a.name))).toBe(subnet);
      expect((await fetch(a.id, "http://probe:8080/")).output.trim()).toBe("resource-ok");
      await refusedAtOnce(a.id, `http://${await addressOn(b.id, reachNetworkName(b.name))}:8080/`);
    });
  });

  it("leaves nothing of a removed workspace: its network, the mirror's endpoint, its subnet", async () => {
    await strict.stop({ resourceId: b.id, reference: b.name });
    const network = await attempt(["network", "inspect", `${b.name}-egress`]);
    expect(network.ok).toBe(false);
    expect(table.released).toContain(`${b.name}-egress`);
    expect(table.held.has(`${b.name}-egress`)).toBe(false);
    const mirrorNetworks = (
      await docker("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", mirror])
    ).stdout;
    expect(mirrorNetworks).not.toContain(`${b.name}-egress`);
    expect(mirrorNetworks).toContain(`${a.name}-egress`);
  });
});

describe("isolated internal bridges", () => {
  const network = `sealant-isolated-e2e-${tag}`;
  const members = [`sealant-isolated-e2e-one-${tag}`, `sealant-isolated-e2e-two-${tag}`];

  afterAll(async () => {
    for (const member of members)
      await docker("docker", ["rm", "-f", member]).catch(() => undefined);
    await docker("docker", ["network", "rm", network]).catch(() => undefined);
  });

  it("is proved on this engine, and carries its members' traffic and nothing to the host", async () => {
    const support = await probeIsolatedGatewaySupport({
      run: docker,
      image: DEFAULT_NETWORK_GUARD_IMAGE,
    });
    expect(support, JSON.stringify(support)).toMatchObject({ supported: true });

    await docker("docker", [
      ...isolatedNetworkCreateArgv({ name: network, subnet: `10.249.${String(RUN_OCTET)}.240/29` }),
    ]);
    for (const [index, member] of members.entries()) {
      await docker("docker", [
        "run",
        "-d",
        "--name",
        member,
        "--network",
        network,
        "--ip",
        `10.249.${String(RUN_OCTET)}.${String(242 + index)}`,
        "busybox:1.37",
        "sh",
        "-c",
        "mkdir -p /www && echo member-ok > /www/index.html && exec httpd -f -p 80 -h /www",
      ]);
    }
    const [one = "", two = ""] = members;
    const peer = await attempt([
      "exec",
      one,
      "wget",
      "-T",
      "10",
      "-qO-",
      `http://10.249.${String(RUN_OCTET)}.243/`,
    ]);
    expect(peer.output.trim()).toBe("member-ok");
    // No gateway address: nothing on the host is a hop away, not even a published port.
    const routes = await docker("docker", ["exec", two, "ip", "route", "show"]);
    expect(routes.stdout).not.toContain("default");
    const host = await attempt([
      "exec",
      one,
      "wget",
      "-T",
      "5",
      "-qO-",
      `http://10.249.${String(RUN_OCTET)}.241/`,
    ]);
    expect(host.ok).toBe(false);
  });
});
