import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { boatExecutionTargetSchema } from "@sealant/validators";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { z } from "zod";

import { boatTunnelName, DockerBoatTunnel } from "./boat-tunnel.js";
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
        held = `10.${subnetByte}.${index++}.0/${kind === "reach" ? 27 : 28}`;
        networks.set(name, held);
      }
      return held;
    },
    release: async () => {},
  };
  const resources = new DockerResourceRuntime({ subnets });
  const runtime = new DockerBoatTunnel({ gatewayImage: image, subnets, resources });
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
        "import socket; s=socket.socket(); s.bind(('0.0.0.0',31000)); s.listen();\nwhile True:\n c,_=s.accept(); c.sendall(b'project\\n'); c.close()",
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
  const hostService = createServer((socket) => socket.end("host-service\n"));
  await new Promise<void>((resolve) => hostService.listen(0, "0.0.0.0", resolve));
  const hostAddress = hostService.address();
  if (hostAddress === null || typeof hostAddress === "string")
    throw new Error("Owned host listener is unavailable");
  let complete = false;
  try {
    for (const instance of [project, other, tree]) {
      containers.add(instanceContainerName(instance.id));
      const ready = await resources.up(instance, []);
      expect(ready.state).toMatchObject({ kind: "running" });
    }
    const empty = await Effect.runPromise(runtime.ensure({ ...input, instances: [] }));
    const endpoint = await Effect.runPromise(runtime.ensure(input));
    expect(endpoint.containerId).toBe(empty.containerId);
    expect(endpoint.receipt).not.toBe(empty.receipt);
    expect(endpoint.peerHandshake).toBe("unverified");
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
    expect(
      (
        await command(hostControl, query, {
          kind: "tcp",
          host: "127.0.0.1",
          port: hostAddress.port,
        })
      ).result,
    ).toBe("host-service");
    await docker("exec", client, "ip", "route", "replace", `${defaultBridge}/32`, "dev", "wg0");
    expect(
      (await command(client, query, { kind: "tcp", host: defaultBridge, port: hostAddress.port }))
        .result,
    ).toBe("denied");
    expect(
      (await command(client, query, { kind: "tcp", host: hostIp, port: hostAddress.port })).result,
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
    await new Promise<void>((resolve, reject) =>
      hostService.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
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
