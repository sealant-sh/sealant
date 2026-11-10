import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { boatExecutionTargetSchema } from "@sealant/validators";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { z } from "zod";

import { createDockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import {
  boatTunnelBinding,
  boatTunnelConfigDigests,
  boatTunnelCreateArgs,
  boatTunnelName,
  DockerBoatTunnel,
} from "./boat-tunnel.js";
import { CALLER_GUARD_IMAGE } from "./docker-caller-runtime.js";
import { instanceContainerName, reachNetworkName } from "./docker-resource-argv.js";
import { DockerResourceRuntime, type ResourceSubnets } from "./docker-resource-runtime.js";
import { linkedExecutor, instanceRecord, postgresSpec } from "./resource.fixture.js";

const imagePath = process.env.SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE;
const docker = async (...args: string[]) =>
  (await promisify(execFile)("docker", args, { timeout: 30_000 })).stdout.trim();
const keys = () => {
  const pair = generateKeyPairSync("x25519");
  return {
    private: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64"),
    public: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  };
};
const executionTarget = (id: string) =>
  boatExecutionTargetSchema.parse({
    deploymentId: "local-proof",
    workspaceId: `ws-${id}`,
    runId: `run-${id}`,
    runtimeInstanceId: `run-${id}`,
    launchAttemptId: id,
    sourceId: "source",
    sandboxId: "bx_23456789",
    diskLineage: id,
    bootId: randomUUID(),
    manifestDigest: "a".repeat(64),
  });
const freePort = async () => {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "0.0.0.0", resolve));
  const port = socket.address().port;
  await new Promise<void>((resolve) => socket.close(resolve));
  return port;
};
const command = async (container: string, script: string, input: unknown) => {
  const child = spawn("docker", ["exec", "-i", container, "python3", "-c", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    if ((await finished) !== 0) throw new Error(`Owned peer command failed: ${stderr.slice(-500)}`);
    return z.object({ result: z.string().optional() }).parse(JSON.parse(stdout));
  } finally {
    clearTimeout(timer);
  }
};
const connectPeer = `
import json,os,subprocess,sys
c=json.load(sys.stdin)
def run(*args): subprocess.run(args,check=True,capture_output=True,timeout=3)
fd=os.memfd_create('test-key');os.write(fd,(c['private']+'\\n').encode());os.lseek(fd,0,0)
if os.path.exists('/sys/class/net/wg0'): run('ip','link','del','wg0')
run('ip','link','add','wg0','type','wireguard')
subprocess.run(['wg','set','wg0','private-key','/proc/self/fd/'+str(fd),'peer',c['public'],'endpoint',c['endpoint'],'allowed-ips','0.0.0.0/0','persistent-keepalive','1'],pass_fds=[fd],check=True,capture_output=True,timeout=3)
os.close(fd)
run('ip','addr','add','100.127.255.254/30','dev','wg0')
run('ip','link','set','wg0','mtu','1380','up')
for subnet in c['routes']: run('ip','route','replace',subnet,'dev','wg0')
print('{}')
`;
const query = `
import json,socket,struct,sys
c=json.load(sys.stdin)
if c['kind']=='tcp':
 try:
  with socket.create_connection((c['host'],c['port']),timeout=1) as s: result=s.recv(256).decode().strip()
 except OSError: result='denied'
else:
 q=struct.pack('!HHHHHH',123,0x100,1,0,0,0)+b''.join(bytes([len(x)])+x.encode() for x in c['host'].split('.'))+b'\\0'+struct.pack('!HH',1,1)
 try:
  kind=socket.SOCK_DGRAM if c['kind']=='dns-udp' else socket.SOCK_STREAM
  with socket.socket(socket.AF_INET,kind) as s:
   s.settimeout(1);s.connect(('100.127.255.253',53));s.sendall(q if kind==socket.SOCK_DGRAM else struct.pack('!H',len(q))+q)
   if kind==socket.SOCK_DGRAM: data=s.recv(4096)
   else:
    size=struct.unpack('!H',s.recv(2))[0];data=b''
    while len(data)<size:
     part=s.recv(size-len(data))
     if not part: raise OSError()
     data+=part
   result=socket.inet_ntoa(data[-4:]) if struct.unpack('!H',data[6:8])[0]>0 else 'missing'
 except OSError: result='denied'
print(json.dumps({'result':result}))
`;
const startHostService = `
import json,socket,subprocess
s=socket.socket();s.bind(('0.0.0.0',0));s.listen()
script="import socket; s=socket.socket(fileno="+str(s.fileno())+");\\nwhile True:\\n c,_=s.accept(); c.sendall(b'host-service\\\\n'); c.close()"
subprocess.Popen(['python3','-c',script],pass_fds=[s.fileno()],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps({'result':str(s.getsockname()[1])}))
`;

it("one WireGuard peer reaches only its linked resources and DNS, with replay and exact cleanup", async () => {
  if (imagePath === undefined)
    throw new Error("Build boat-tunnel/Dockerfile and set SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE");
  const image = (await readFile(imagePath, "utf8")).trim();
  const networks = new Map<string, string>();
  const containers = new Set<string>();
  const subnetByte = Math.floor(Math.random() * 200) + 10;
  let index = 0;
  const subnets: ResourceSubnets = {
    allocate: async ({ name, kind }) => {
      let held = networks.get(name);
      if (held === undefined) {
        held = `10.${subnetByte}.${index++}.${kind === "reach" ? "32/27" : "16/28"}`;
        networks.set(name, held);
      }
      return held;
    },
    release: async () => {},
  };
  const resources = new DockerResourceRuntime({ subnets });
  // The peers here are containers on the gateway's own bridge, standing in for the worker's
  // carrier: they reach the port on that bridge's address, known only once the gateway exists.
  const runtime = new DockerBoatTunnel({
    gatewayImage: image,
    subnets,
    resources,
    publishHost: "0.0.0.0",
  });
  const first = executionTarget(randomUUID());
  const second = executionTarget(randomUUID());
  const link = {
    ...linkedExecutor("fixture", "tree", undefined, { db: "project" }),
    workspaceId: first.workspaceId,
  };
  const project = instanceRecord({
    uuid: randomUUID(),
    spec: postgresSpec({
      alias: "db",
      volumes: [],
      env: {},
      image: CALLER_GUARD_IMAGE,
      command: [
        "python3",
        "-c",
        "import signal,socket,sys; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); s=socket.socket(); s.bind(('0.0.0.0',31000)); s.listen();\nwhile True:\n c,_=s.accept(); c.sendall(b'project\\n'); c.close()",
      ],
      ready: { kind: "exec", argv: ["true"], user: null },
      limits: { cpuMillicores: 500, memoryBytes: 134217728 },
    }),
  });
  const other = instanceRecord({
    spec: project.spec,
    uuid: randomUUID(),
    resourceDomainId: "rdm:22222222-2222-4333-8444-555555555555",
  });
  const tree = instanceRecord({
    uuid: randomUUID(),
    spec: postgresSpec({
      ...project.spec,
      worktreeKey: link.worktreeKey,
      command: project.spec.command?.map((part) => part.replace("b'project", "b'worktree")),
    }),
  });
  const own = keys();
  const peer = keys();
  const otherPeer = keys();
  const input = {
    target: first,
    privateKey: Redacted.make(own.private),
    peerKey: peer.public,
    listenPort: await freePort(),
    link,
    instances: [project, other, tree],
  };
  let complete = false;
  try {
    const preflight = `${boatTunnelName(first)}-preflight`;
    containers.add(preflight);
    try {
      await docker(
        "run",
        "--rm",
        "--name",
        preflight,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "ip",
        image,
        "link",
        "add",
        "wg0",
        "type",
        "wireguard",
      );
    } catch (cause) {
      throw new Error("Boat tunnel proof requires kernel WireGuard and Docker NET_ADMIN support", {
        cause,
      });
    }
    for (const instance of [project, other, tree]) {
      containers.add(instanceContainerName(instance.id));
      const ready = await resources.up(instance, []);
      expect(ready.state).toMatchObject({ kind: "running" });
    }
    const empty = await Effect.runPromise(
      runtime.ensure({ ...input, link: undefined, instances: [] }),
    );
    // A person's Stop is authoritative even while launching a new remote workspace.
    await resources.stop(project);
    await expect(Effect.runPromise(runtime.ensure(input))).rejects.toThrow(
      /ownership-conflict|gateway-unavailable/,
    );
    const stoppedProject = { ...project, desired: "stopped" as const };
    expect(
      await Effect.runPromise(
        runtime.ensure({
          ...input,
          instances: [stoppedProject, other, tree],
        }),
      ),
    ).toEqual(empty);
    expect((await resources.up(project, [])).state.kind).toBe("running");
    const endpoint = await Effect.runPromise(runtime.ensure(input));
    expect(endpoint.containerId).toBe(empty.containerId);
    expect(endpoint.receipt).not.toBe(empty.receipt);
    expect(endpoint.peerHandshake).toBe("unverified");
    const released: string[] = [];
    const nativeRunner = createDockerCommandRunner("/var/run/docker.sock");
    const reserved = boatTunnelName(executionTarget(randomUUID()));
    const ordinary = new DockerResourceRuntime({
      subnets: {
        ...subnets,
        release: async (name) => {
          released.push(name);
        },
      },
      commandRunner: async (binary, args, options) => {
        const result = await nativeRunner(binary, args, options);
        // The shared daemon may hold unrelated workspaces. This proof inventories only its own reach network.
        if (args[0] === "network" && args[1] === "ls")
          return {
            ...result,
            stdout: result.stdout
              .split("\n")
              .filter((name) => name === reachNetworkName(endpoint.container))
              .join("\n"),
          };
        return result;
      },
    });
    await ordinary.converge({
      desired: [],
      liveExecutors: [],
      knownExecutors: [endpoint.container, reserved],
    });
    expect(released).toEqual([]);
    const replay = await Effect.runPromise(runtime.ensure(input));
    expect(replay).toEqual(endpoint);
    await expect(
      Effect.runPromise(runtime.ensure({ ...input, peerKey: otherPeer.public })),
    ).rejects.toThrow("ownership-conflict");
    await expect(
      Effect.runPromise(runtime.ensure({ ...input, target: { ...first, bootId: randomUUID() } })),
    ).rejects.toThrow("ownership-conflict");
    const otherInput = {
      ...input,
      target: second,
      privateKey: Redacted.make(keys().private),
      peerKey: otherPeer.public,
      listenPort: await freePort(),
      link: { ...link, workspaceId: second.workspaceId, resourceDomainId: other.resourceDomainId },
    };
    const endpoint2 = await Effect.runPromise(runtime.ensure(otherInput));
    const bridge = await docker(
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      `${endpoint.container}-egress`,
    );
    const client = `${endpoint.container}-client`;
    const wrong = `${endpoint.container}-wrong`;
    for (const name of [client, wrong]) {
      containers.add(name);
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      );
      await command(name, connectPeer, {
        private: name === client ? peer.private : otherPeer.private,
        public: own.public,
        endpoint: `${bridge}:${input.listenPort}`,
        routes: [endpoint.reachSubnet, endpoint2.reachSubnet],
      });
    }
    const resolved = await command(client, query, { kind: "dns-udp", host: "db" });
    expect(resolved.result).not.toBe("denied");
    expect(resolved.result).not.toBe("missing");
    expect((await command(client, query, { kind: "dns-tcp", host: "db" })).result).toBe(
      resolved.result,
    );
    expect(
      (await command(client, query, { kind: "tcp", host: resolved.result, port: 31000 })).result,
    ).toBe("project");
    await resources.stop(project);
    await Effect.runPromise(
      runtime.ensure({
        ...input,
        instances: [stoppedProject, other, tree],
      }),
    );
    // No cached DNS answer or old endpoint may point this session at the stopped resource.
    for (const kind of ["dns-udp", "dns-tcp"])
      expect(["missing", "denied"]).toContain(
        (await command(client, query, { kind, host: "db" })).result,
      );
    expect(
      (await command(client, query, { kind: "tcp", host: resolved.result, port: 31000 })).result,
    ).toBe("denied");
    expect((await resources.up(project, [])).state.kind).toBe("running");
    await Effect.runPromise(runtime.ensure(input));
    const otherIp = await docker(
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${reachNetworkName(endpoint2.container)}").IPAddress}}`,
      instanceContainerName(other.id),
    );
    expect((await command(client, query, { kind: "tcp", host: otherIp, port: 31000 })).result).toBe(
      "denied",
    );
    const hostIp = await docker(
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      reachNetworkName(endpoint.container),
    );
    const defaultBridge = await docker(
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      "bridge",
    );
    const hostControl = `${endpoint.container}-host-control`;
    containers.add(hostControl);
    await docker(
      "run",
      "-d",
      "--name",
      hostControl,
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    );
    const hostPort = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse((await command(hostControl, startHostService, {})).result);
    expect(
      (
        await command(hostControl, query, {
          kind: "tcp",
          host: "127.0.0.1",
          port: hostPort,
        })
      ).result,
    ).toBe("host-service");
    await docker("exec", client, "ip", "route", "replace", `${defaultBridge}/32`, "dev", "wg0");
    expect(
      (await command(client, query, { kind: "tcp", host: defaultBridge, port: hostPort })).result,
    ).toBe("denied");
    expect(
      (await command(client, query, { kind: "tcp", host: hostIp, port: hostPort })).result,
    ).toBe("denied");
    expect((await command(wrong, query, { kind: "dns-udp", host: "db" })).result).toBe("denied");
    expect(
      (await command(client, query, { kind: "dns-udp", host: instanceContainerName(other.id) }))
        .result,
    ).toMatch(/^(missing|denied)$/);
    const relink = {
      ...input,
      link: {
        ...linkedExecutor("fixture", "tree", undefined, { db: "worktree" }),
        workspaceId: first.workspaceId,
      },
    };
    const changed = await Effect.runPromise(runtime.ensure(relink));
    expect(changed.containerId).toBe(endpoint.containerId);
    expect(changed.receipt).not.toBe(endpoint.receipt);
    const treeIp = (await command(client, query, { kind: "dns-udp", host: "db" })).result;
    expect(treeIp).not.toBe(resolved.result);
    expect((await command(client, query, { kind: "tcp", host: treeIp, port: 31000 })).result).toBe(
      "worktree",
    );
    expect(
      (await command(client, query, { kind: "tcp", host: resolved.result, port: 31000 })).result,
    ).toBe("denied");
    await docker("restart", endpoint.container);
    const restarted = await Effect.runPromise(runtime.ensure(relink));
    expect(restarted.containerId).toBe(changed.containerId);
    expect(restarted.gatewayEpoch).not.toBe(changed.gatewayEpoch);
    expect(restarted.receipt).not.toBe(changed.receipt);
    await command(client, connectPeer, {
      private: peer.private,
      public: own.public,
      endpoint: `${bridge}:${input.listenPort}`,
      routes: [endpoint.reachSubnet, endpoint2.reachSubnet],
    });
    expect((await command(client, query, { kind: "tcp", host: treeIp, port: 31000 })).result).toBe(
      "worktree",
    );
    await docker("network", "connect", `${endpoint2.container}-egress`, endpoint.container);
    await expect(Effect.runPromise(runtime.ensure(relink))).rejects.toThrow("ownership-conflict");
    await docker("network", "disconnect", `${endpoint2.container}-egress`, endpoint.container);
    await docker("update", "--memory", "268435456", endpoint.container);
    await expect(Effect.runPromise(runtime.ensure(relink))).rejects.toThrow("ownership-conflict");
    await docker("update", "--memory", "134217728", endpoint.container);
    await docker("exec", endpoint.container, "iptables", "-I", "FORWARD", "1", "-j", "ACCEPT");
    await expect(Effect.runPromise(runtime.ensure(relink))).rejects.toThrow("gateway-unavailable");
    await docker("exec", endpoint.container, "iptables", "-D", "FORWARD", "1");
    await docker("exec", endpoint.container, "iptables", "-D", "FORWARD", "1");
    await docker(
      "exec",
      endpoint.container,
      "iptables",
      "-A",
      "FORWARD",
      "-i",
      "wg0",
      "-d",
      `${hostIp}/32`,
      "-j",
      "REJECT",
    );
    await expect(Effect.runPromise(runtime.ensure(relink))).rejects.toThrow("gateway-unavailable");
    await docker("exec", endpoint.container, "iptables", "-D", "FORWARD", "4");
    await docker(
      "exec",
      endpoint.container,
      "iptables",
      "-I",
      "FORWARD",
      "1",
      "-i",
      "wg0",
      "-d",
      `${hostIp}/32`,
      "-j",
      "REJECT",
    );
    expect(await Effect.runPromise(runtime.ensure(relink))).toEqual(restarted);
    const inspection = await docker("inspect", "--format", "{{json .}}", endpoint.container);
    expect(inspection).not.toContain(own.private);
    const hostConfig = z
      .object({
        HostConfig: z.object({
          CapAdd: z.array(z.string()),
          CapDrop: z.array(z.string()),
          PortBindings: z.record(z.string(), z.unknown()),
          ReadonlyRootfs: z.boolean(),
          Privileged: z.boolean(),
        }),
      })
      .parse(JSON.parse(inspection)).HostConfig;
    expect(hostConfig.CapAdd.map((value: string) => value.replace(/^CAP_/, ""))).toEqual([
      "NET_ADMIN",
    ]);
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(Object.keys(hostConfig.PortBindings)).toEqual(["51820/udp"]);
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.Privileged).toBe(false);
    await Effect.runPromise(runtime.remove(first));
    expect(
      await docker("inspect", "--format", "{{.State.Running}}", instanceContainerName(project.id)),
    ).toBe("true");
    await Effect.runPromise(runtime.remove(first));
    await Effect.runPromise(runtime.remove(second));
    const reusedInput = { ...otherInput, listenPort: input.listenPort };
    const reused = await Effect.runPromise(runtime.ensure(reusedInput));
    await Effect.runPromise(runtime.remove(first));
    expect(await Effect.runPromise(runtime.ensure(reusedInput))).toEqual(reused);
    const reusedBridge = await docker(
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      `${reused.container}-egress`,
    );
    await command(wrong, connectPeer, {
      private: otherPeer.private,
      public: reused.publicKey,
      endpoint: `${reusedBridge}:${input.listenPort}`,
      routes: [reused.reachSubnet],
    });
    const reusedResource = (await command(wrong, query, { kind: "dns-udp", host: "db" })).result;
    expect(reusedResource).not.toBe("denied");
    expect(reusedResource).not.toBe("missing");
    expect(
      (await command(wrong, query, { kind: "tcp", host: reusedResource, port: 31000 })).result,
    ).toBe("project");
    await command(client, connectPeer, {
      private: peer.private,
      public: own.public,
      endpoint: `${reusedBridge}:${input.listenPort}`,
      routes: [reused.reachSubnet],
    });
    expect((await command(client, query, { kind: "dns-udp", host: "db" })).result).toBe("denied");
    containers.add(endpoint.container);
    await docker(
      "create",
      "--name",
      endpoint.container,
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    );
    await expect(Effect.runPromise(runtime.ensure(input))).rejects.toThrow("ownership-conflict");
    await expect(Effect.runPromise(runtime.remove(first))).rejects.toThrow("ownership-conflict");
    expect(await docker("inspect", "--format", "{{.State.Status}}", endpoint.container)).toBe(
      "created",
    );
    complete = true;
  } finally {
    for (const target of complete ? [] : [first, second]) {
      const name = boatTunnelName(target);
      const logs = await promisify(execFile)("docker", ["logs", name], { timeout: 5000 }).catch(
        () => undefined,
      );
      if (logs) console.info("Owned gateway log", logs.stdout, logs.stderr);
      const rules = await docker("exec", name, "iptables", "-S").catch(() => "");
      if (rules) console.info("Owned gateway rules", rules);
    }
    for (const name of [first, second])
      await Effect.runPromise(runtime.remove(name)).catch(() => undefined);
    for (const name of containers) await docker("rm", "-f", name).catch(() => undefined);
    for (const name of networks.keys()) await docker("network", "rm", name).catch(() => undefined);
    const remaining = await docker("ps", "-a", "--format", "{{.Names}}");
    for (const name of [...containers, boatTunnelName(first), boatTunnelName(second)])
      expect(remaining.split("\n")).not.toContain(name);
    const remainingNetworks = await docker("network", "ls", "--format", "{{.Name}}");
    for (const name of networks.keys()) expect(remainingNetworks.split("\n")).not.toContain(name);
  }
});

it("waits for a late gateway DNS control answer before acknowledging configuration", async () => {
  if (imagePath === undefined) throw new Error("SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE required");
  const base = (await readFile(imagePath, "utf8")).trim();
  const context = await mkdtemp(join(tmpdir(), "boat-gateway-late-"));
  const fixtureTag = `sealant-boat-gateway-delay:${randomUUID()}`;
  let fixtureImage: string | undefined;
  const held = new Map<string, string>();
  const subnets: ResourceSubnets = {
    allocate: async ({ name, kind }) => {
      const subnet =
        held.get(name) ??
        `10.189.${Math.floor(Math.random() * 200) + 10}.${kind === "reach" ? "32/27" : "16/28"}`;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name) => {
      held.delete(name);
    },
  };
  const target = executionTarget(randomUUID());
  let runtime: DockerBoatTunnel | undefined;
  try {
    const source = await readFile(new URL("../../boat-tunnel/gateway.py", import.meta.url), "utf8");
    const delayed = source.replace(
      "    child = subprocess.Popen(['dnsmasq'",
      "    time.sleep(8)\n    child = subprocess.Popen(['dnsmasq'",
    );
    if (source === delayed) throw new Error("missing real gateway serve seam");
    await writeFile(join(context, "gateway.py"), delayed);
    // Build this fixture from the production Dockerfile. Tagging the shared untagged image
    // and then removing its last tag would delete the input needed by later guest proofs.
    await writeFile(
      join(context, "Dockerfile"),
      await readFile(new URL("../../boat-tunnel/Dockerfile", import.meta.url), "utf8"),
    );
    fixtureImage = await docker("build", "--quiet", "--tag", fixtureTag, context);
    const resources = new DockerResourceRuntime({ subnets });
    runtime = new DockerBoatTunnel({
      gatewayImage: fixtureImage,
      resources,
      subnets,
      publishHost: "127.0.0.1",
    });
    const own = keys(),
      peer = keys();
    const started = Date.now();
    const result = await Effect.runPromise(
      runtime.ensure({
        target,
        privateKey: Redacted.make(own.private),
        peerKey: peer.public,
        listenPort: await freePort(),
        instances: [],
        link: undefined,
      }),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(8000);
    expect(result).toMatchObject({
      container: boatTunnelName(target),
      peerHandshake: "unverified",
    });
    // Cleanup uses exact Docker ownership, even when the gateway no longer answers.
    await docker("stop", result.container);
    await Effect.runPromise(runtime.remove(target));
    await Effect.runPromise(runtime.remove(target));
    expect(held.size).toBe(0);
  } finally {
    if (runtime !== undefined) await Effect.runPromise(runtime.remove(target));
    if (fixtureImage !== undefined) await docker("image", "rm", "--no-prune", fixtureTag);
    await rm(context, { recursive: true, force: true });
    // CI shares this untagged immutable input with the subsequent guest network proof.
    await docker("image", "inspect", base);
  }
});

it("publishes WireGuard on the relay host only, where the worker relays the carried tunnel", async () => {
  if (imagePath === undefined) throw new Error("SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE required");
  const image = (await readFile(imagePath, "utf8")).trim();
  const held = new Map<string, string>();
  const subnets: ResourceSubnets = {
    allocate: async ({ name, kind }) => {
      const subnet =
        held.get(name) ??
        `10.190.${Math.floor(Math.random() * 200) + 10}.${kind === "reach" ? "32/27" : "16/28"}`;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name) => {
      held.delete(name);
    },
  };
  const target = executionTarget(randomUUID());
  const resources = new DockerResourceRuntime({ subnets });
  const runtime = new DockerBoatTunnel({
    gatewayImage: image,
    resources,
    subnets,
    publishHost: "127.0.0.1",
  });
  const own = keys(),
    peer = keys();
  const listenPort = await freePort();
  const request = {
    target,
    privateKey: Redacted.make(own.private),
    peerKey: peer.public,
    listenPort,
    instances: [],
    link: undefined,
  };
  try {
    const result = await Effect.runPromise(runtime.ensure(request));
    const bindings = z
      .record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })))
      .parse(
        JSON.parse(
          await docker(
            "inspect",
            "--format",
            "{{json .HostConfig.PortBindings}}",
            result.container,
          ),
        ),
      );
    // Never on a public interface: only where the worker relays the carried tunnel.
    expect(bindings).toEqual({
      "51820/udp": [{ HostIp: "127.0.0.1", HostPort: String(listenPort) }],
    });
    // A replay adopts the same gateway; nothing is recreated.
    expect(await Effect.runPromise(runtime.ensure(request))).toEqual(result);

    // A gateway as the release before this one made it on a deployment whose VMs dialled it: the
    // same container, published on every interface, labelled without a relay host. A session
    // started before the upgrade has one, and must keep it.
    await docker("rm", "-f", result.container);
    const digests = boatTunnelConfigDigests(
      {
        binding: boatTunnelBinding(target),
        publicKey: own.public,
        peerKey: peer.public,
        listenPort,
        gatewayImage: image,
      },
      "127.0.0.1",
    );
    await docker(
      ...boatTunnelCreateArgs({
        name: result.container,
        binding: boatTunnelBinding(target),
        configDigest: digests.dialled,
        egress: `${result.container}-egress`,
        publish: String(listenPort),
        gatewayImage: image,
      }),
    );
    const dialledId = await docker("inspect", "--format", "{{.Id}}", result.container);
    expect(dialledId).not.toBe(result.containerId);
    // Adopted as it is: started, configured and answered for, never refused or replaced.
    const adopted = await Effect.runPromise(runtime.ensure(request));
    expect(adopted).toMatchObject({
      container: result.container,
      containerId: dialledId,
      publicKey: own.public,
      peerKey: peer.public,
      listenPort,
      reachSubnet: result.reachSubnet,
    });
    expect(await docker("inspect", "--format", "{{.Id}}", result.container)).toBe(dialledId);
    expect(
      JSON.parse(
        await docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", result.container),
      ),
    ).toEqual({ "51820/udp": [{ HostIp: "", HostPort: String(listenPort) }] });
    expect(await Effect.runPromise(runtime.ensure(request))).toEqual(adopted);
    // A gateway that is neither (another port's label, say) is still refused, and left alone.
    await docker("rm", "-f", result.container);
    await docker(
      ...boatTunnelCreateArgs({
        name: result.container,
        binding: boatTunnelBinding(target),
        configDigest: "f".repeat(64),
        egress: `${result.container}-egress`,
        publish: `127.0.0.1:${String(listenPort)}`,
        gatewayImage: image,
      }),
    );
    const foreignId = await docker("inspect", "--format", "{{.Id}}", result.container);
    await expect(Effect.runPromise(runtime.ensure(request))).rejects.toThrow("ownership-conflict");
    expect(await docker("inspect", "--format", "{{.Id}}", result.container)).toBe(foreignId);
  } finally {
    await Effect.runPromise(runtime.remove(target));
    expect(held.size).toBe(0);
  }
});
