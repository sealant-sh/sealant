import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { callerInstanceName, parseResourceCallers } from "./caller-config.js";
import { CALLER_GUARD_IMAGE, DockerCallerRuntime } from "./docker-caller-runtime.js";
import { instanceRecord, postgresSpec } from "./resource.fixture.js";

const docker = async (...args: string[]) =>
  (await promisify(execFile)("docker", args, { timeout: 120_000 })).stdout.trim();

// A private recursive resolver forwards through its own unguarded Docker DNS. It also listens
// on non-DNS ports, so a rejection proves filtering rather than an absent destination listener.
const resolverScript = `
import socket, struct, threading
upstream = next(line.split()[1] for line in open('/etc/resolv.conf') if line.startswith('nameserver '))
def exact(sock, size):
    result = b''
    while len(result) < size:
        part = sock.recv(size - len(result))
        if not part: raise EOFError()
        result += part
    return result
def tcp_dns(client):
    with client, socket.create_connection((upstream, 53), timeout=3) as remote:
        query = exact(client, 2)
        query += exact(client, struct.unpack('!H', query)[0])
        remote.sendall(query)
        length = exact(remote, 2)
        client.sendall(length + exact(remote, struct.unpack('!H', length)[0]))
def tcp(port):
    with socket.socket() as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('0.0.0.0', port)); server.listen()
        while True:
            client, _ = server.accept()
            if port == 53: threading.Thread(target=tcp_dns, args=(client,), daemon=True).start()
            else: client.sendall(b'private-listener\\n'); client.close()
def udp(port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind(('0.0.0.0', port))
        while True:
            query, peer = server.recvfrom(65535)
            if port == 53:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as remote:
                    remote.settimeout(3); remote.sendto(query, (upstream, 53))
                    answer = remote.recv(65535)
            else: answer = b'private-listener'
            server.sendto(answer, peer)
for port in (53, 8080): threading.Thread(target=tcp, args=(port,), daemon=True).start()
for port in (53, 5353): threading.Thread(target=udp, args=(port,), daemon=True).start()
print('ready', flush=True)
threading.Event().wait()
`;

it("caller DNS reaches only configured private upstreams, over UDP and TCP", async () => {
  const instance = instanceRecord({
    uuid: randomUUID(),
    spec: postgresSpec({
      image: CALLER_GUARD_IMAGE,
      command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 0.1; done"],
      env: {},
      ready: { kind: "exec", argv: ["true"], user: null },
      idleStopAfterSeconds: null,
      reach: { kind: "caller", caller: "mend", port: 4400, callbackPort: 4401 },
      volumes: [{ name: "data", mountPath: "/app/data", storageBytes: 1048576 }],
    }),
  });
  const name = callerInstanceName(instance.id);
  const caller = `${name}-client`;
  const resolver = `${name}-resolver`;
  const otherResolver = `${name}-other-resolver`;
  const egress = `${name}-egress`;
  const privateNet = `${name}-caller`;
  const runtime = new DockerCallerRuntime({
    subnets: {
      allocate: async ({ name: network }) =>
        docker("network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", network),
      release: async () => {},
    },
    callers: parseResourceCallers(
      JSON.stringify([{ kind: "docker", name: "mend", container: caller, callbackPorts: [4401] }]),
    ),
  });
  try {
    await docker("network", "create", egress);
    await docker("network", "create", "--internal", privateNet);
    for (const container of [resolver, otherResolver]) {
      await docker(
        "run",
        "-d",
        "--name",
        container,
        "--network",
        egress,
        "--cap-drop",
        "ALL",
        "--entrypoint",
        "python3",
        CALLER_GUARD_IMAGE,
        "-u",
        "-c",
        resolverScript,
      );
      await docker(
        "exec",
        container,
        "sh",
        "-c",
        "for i in $(seq 1 50); do nc -z 127.0.0.1 8080 && exit 0; sleep 0.1; done; exit 1",
      );
    }
    const ip = await docker(
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${egress}").IPAddress}}`,
      resolver,
    );
    const otherIp = await docker(
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${egress}").IPAddress}}`,
      otherResolver,
    );
    expect(ip).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
    // Preseed the normal anchor with a daemon-equivalent DNS override. All subsequent workload
    // creation and guard installation goes through the production provider, without a mock.
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      egress,
      "--dns",
      ip,
      "--cap-drop",
      "ALL",
      "--entrypoint",
      "sleep",
      CALLER_GUARD_IMAGE,
      "infinity",
    );
    await docker(
      "run",
      "-d",
      "--name",
      caller,
      "--network",
      egress,
      "--cap-drop",
      "ALL",
      "--entrypoint",
      "sleep",
      CALLER_GUARD_IMAGE,
      "infinity",
    );
    const dig = (container: string, server: string, tcp: boolean) =>
      docker(
        "exec",
        container,
        "dig",
        `@${server}`,
        "registry.npmjs.org",
        "A",
        "+short",
        "+time=2",
        "+tries=1",
        ...(tcp ? ["+tcp"] : []),
      );
    const privateUdp = (container: string) =>
      docker(
        "exec",
        container,
        "python3",
        "-c",
        `import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2)
try:
    s.sendto(b'probe',('${ip}',5353))
    print(s.recv(100).decode())
except (TimeoutError,ConnectionRefusedError,PermissionError): print('blocked')`,
      );
    for (const tcp of [false, true]) {
      expect(await dig(name, "127.0.0.11", tcp)).toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(await dig(name, otherIp, tcp)).toMatch(/\d+\.\d+\.\d+\.\d+/);
    }
    await docker("exec", name, "nc", "-z", "-w", "2", ip, "8080");
    expect(await privateUdp(name)).toBe("private-listener");
    expect((await runtime.up(instance)).state.kind).toBe("running");
    const workload = `${name}-workload`;
    const config = await docker("exec", name, "cat", "/etc/resolv.conf");
    console.info("Private resolver fixture", { ip, otherIp, config });
    for (const tcp of [false, true]) {
      expect(await dig(workload, "127.0.0.11", tcp)).toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(await dig(workload, ip, tcp)).toMatch(/\d+\.\d+\.\d+\.\d+/);
      await expect(dig(workload, otherIp, tcp)).rejects.toThrow();
    }
    await expect(docker("exec", workload, "nc", "-z", "-w", "2", ip, "8080")).rejects.toThrow();
    await expect(
      docker("exec", workload, "nc", "-z", "-w", "2", otherIp, "8080"),
    ).rejects.toThrow();
    expect(await privateUdp(workload)).toBe("blocked");
    await expect(
      docker("exec", workload, "sh", "-c", "echo '# modified' >> /etc/resolv.conf"),
    ).rejects.toThrow();
    expect((await runtime.up(instance)).state.kind).toBe("running");
    expect(await dig(workload, "127.0.0.11", false)).toMatch(/\d+\.\d+\.\d+\.\d+/);
    console.info(
      "Verified embedded/direct UDP+TCP DNS, other-resolver refusal, private TCP+UDP refusal",
    );
    await docker("exec", workload, "sh", "-c", "echo retained > /app/data/dns-migration");
    await runtime.stop(instance);
    await docker("container", "inspect", "--format", "{{.Name}}", workload);
    await docker("rm", workload);
    const epoch = await docker("inspect", "--format", "{{.State.StartedAt}}", name);
    await docker(
      "run",
      "-d",
      "--name",
      workload,
      "--network",
      `container:${name}`,
      "--label",
      `sealant.resource-spec-digest=${instance.specDigest}`,
      "--label",
      `sealant.resource-anchor-epoch=${epoch}`,
      "--volume",
      `${name}-data:/app/data`,
      "--entrypoint",
      "sh",
      CALLER_GUARD_IMAGE,
      "-c",
      "trap 'exit 0' TERM; while :; do sleep 0.1; done",
    );
    const legacyId = await docker("inspect", "--format", "{{.Id}}", workload);
    expect((await runtime.up(instance)).state.kind).toBe("running");
    expect(await docker("inspect", "--format", "{{.Id}}", workload)).not.toBe(legacyId);
    expect(await docker("exec", workload, "cat", "/app/data/dns-migration")).toBe("retained");
    await expect(
      docker("exec", workload, "sh", "-c", "echo '# modified' >> /etc/resolv.conf"),
    ).rejects.toThrow();
    console.info(
      "Legacy workload replaced with read-only DNS configuration; retained data preserved",
    );
    // Also cover Core's ordinary creation path with no override. On a LAN host this exercises
    // Docker's host(address) metadata; CI uses whatever IPv4 resolver its daemon configures.
    await runtime.stop(instance);
    await docker("container", "inspect", "--format", "{{.Name}}", workload, name);
    await docker("rm", "-f", workload, name);
    expect((await runtime.up(instance)).state.kind).toBe("running");
    console.info(
      "Daemon-default resolver configuration",
      await docker("exec", name, "cat", "/etc/resolv.conf"),
    );
    for (const tcp of [false, true])
      expect(await dig(workload, "127.0.0.11", tcp)).toMatch(/\d+\.\d+\.\d+\.\d+/);
  } finally {
    const containers = [
      name,
      `${name}-workload`,
      `${name}-guard`,
      `${name}-caller-guard`,
      caller,
      resolver,
      otherResolver,
    ];
    console.info("Cleaning only test resources", {
      containers,
      networks: [privateNet, egress],
      volume: `${name}-data`,
    });
    for (const container of containers.toReversed()) {
      await docker("container", "inspect", "--format", "{{.Name}}", container).then(
        () => docker("rm", "-f", container),
        () => undefined,
      );
    }
    for (const network of [privateNet, egress]) {
      await docker("network", "inspect", "--format", "{{.Name}}", network).then(
        () => docker("network", "rm", network),
        () => undefined,
      );
    }
    await docker("volume", "inspect", "--format", "{{.Name}}", `${name}-data`).then(
      () => docker("volume", "rm", `${name}-data`),
      () => undefined,
    );
  }
}, 120_000);
