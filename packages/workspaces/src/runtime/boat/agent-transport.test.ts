/**
 * Core's real Boat execution owner and guest transport (`execution.ts`) against the real guest
 * agent (`microvm-image/agent.mjs`, `SEALANT_AGENT_HOST=boat`) and the real bind CLI, on a fake VM:
 * a boot-id file the test can "reboot", a fake `sealantd` that answers on its control socket or
 * exits 75/76, fake `ip`/`wg`/`iptables`/`unshare`/`sync`, a fake gateway resolver. Only the
 * provider edge is substituted: `execute` runs the bind CLI locally, `hostControl` names a hosted
 * origin that is routed to the agent's port, and the execution record lives in memory.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { credentialCipherLayer } from "@sealant/credentials";
import { BoatExecutionRepo, BoatExecutionStoreError } from "@sealant/db";
import {
  boatExecutionRecordSchema,
  boatExecutionTargetSchema,
  type BoatExecutionRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import {
  BOAT_AGENT_GATEWAY_ADDRESS,
  boatAgentBindRecordSchema,
  boatAgentLaunchRecordSchema,
  boatAgentParkReceiptSchema,
} from "./agent-contract.js";
import type { BoatApi, BoatSandbox } from "./api.js";
import { BoatSecret, boatSandboxIdSchema } from "./config.js";
import {
  BoatExecution,
  BoatExecutionError,
  BoatGuestTransportService,
  boatExecutionLayerNoDeps,
  createBoatGuestTransport,
  type BoatGuestTransport,
  type BoatLaunchMaterial,
} from "./execution.js";
import { boatLaunchDiagnostic } from "./launch-diagnostics.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT = path.join(PACKAGE_ROOT, "microvm-image/agent.mjs");
const BIND_CLI = path.join(PACKAGE_ROOT, "microvm-image/boat-bind.mjs");
const HOSTED_ORIGIN = "https://fixture-8080.on.boat.dev";
const MANIFEST_DIGEST = createHash("sha256").update("boat image manifest").digest("hex");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// ---- The fake VM ---------------------------------------------------------------------------

const FAKE_SEALANTD = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.env.SEALANT_CONTROL_SOCKET;
const record = process.env.FAKE_SEALANTD_RECORD;
fs.writeFileSync(record + ".tmp", JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }));
fs.renameSync(record + ".tmp", record);
fs.appendFileSync(record + ".pids", process.pid + "\\n");
if (process.env.FAKE_SEALANTD_RECOVERY_EXIT76 === "1" && process.argv.includes("--recovery")) {
  fs.writeSync(2, "sealantd boot: nothing to save: never materialized (/workspace/repo)\\n");
  process.exit(76);
} else if (process.env.FAKE_SEALANTD_EXIT75 === "1" && !process.argv.includes("--recovery")) {
  fs.writeSync(2, "Error: final capture incomplete; exiting with EX_TEMPFAIL\\n");
  process.exit(75);
} else {
  const server = net.createServer((socket) => socket.pipe(socket));
  server.listen(socketPath);
  process.on("SIGTERM", () => { server.close(); process.exit(0); });
}
`;
const fakeNetTool = (log: string, handshakeFile: string) => `#!/bin/sh
name=$(basename "$0")
printf '%s %s\\n' "$name" "$*" >> ${JSON.stringify(log)}
if [ "$name" = wg ]; then
  case "$1" in
    set) shift 2; [ "$1" = private-key ] && cat "$2" > ${JSON.stringify(`${log}.wg-key`)} ;;
    show) cat ${JSON.stringify(handshakeFile)} 2>/dev/null ;;
  esac
fi
exit 0
`;
const FAKE_UNSHARE = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;
const fakeSync = (log: string) => `#!/bin/sh
printf 'sync\\n' >> ${JSON.stringify(log)}
exit 0
`;

interface Vm {
  readonly dir: string;
  readonly bootIdFile: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly recordFile: string;
  readonly netLog: string;
  readonly syncLog: string;
  readonly env: Record<string, string>;
  readonly bootId: () => Promise<string>;
  readonly reboot: () => Promise<string>;
  readonly setHandshake: (line: string) => Promise<void>;
}
interface Agent {
  readonly vm: Vm;
  readonly child: ChildProcess;
  readonly port: number;
}
const vms = new Set<Vm>();
const agents = new Set<Agent>();
const writeExecutable = async (file: string, content: string) => {
  await writeFile(file, content);
  await chmod(file, 0o755);
};
const createVm = async (dnsPort: number): Promise<Vm> => {
  const dir = await mkdtemp(path.join(tmpdir(), "boat-core-agent-"));
  const bin = path.join(dir, "bin");
  const etc = path.join(dir, "etc");
  await mkdir(bin);
  await mkdir(etc);
  const netLog = path.join(dir, "net.log");
  const syncLog = path.join(dir, "sync.log");
  const handshakeFile = path.join(dir, "wg-handshake");
  await Promise.all([
    writeExecutable(path.join(bin, "sealantd"), FAKE_SEALANTD),
    writeExecutable(path.join(bin, "sealantctl"), "#!/bin/sh\nexit 0\n"),
    writeExecutable(path.join(bin, "ip"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "wg"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "iptables"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "unshare"), FAKE_UNSHARE),
    writeExecutable(path.join(bin, "sync"), fakeSync(syncLog)),
  ]);
  const bootIdFile = path.join(dir, "boot_id");
  await writeFile(bootIdFile, `${randomUUID()}\n`);
  const dataDir = path.join(dir, "data");
  const stateDir = path.join(dir, "state");
  const manifestFile = path.join(dir, "manifest.json");
  await writeFile(manifestFile, JSON.stringify({ digest: MANIFEST_DIGEST }));
  await writeFile(path.join(etc, "stub-resolv.conf"), "nameserver 127.0.0.53\n");
  const resolvConf = path.join(etc, "resolv.conf");
  await symlink(path.join(etc, "stub-resolv.conf"), resolvConf);
  const socketPath = path.join(dir, "control.sock");
  const recordFile = path.join(dir, "sealantd-record.json");
  const vm: Vm = {
    dir,
    bootIdFile,
    dataDir,
    socketPath,
    recordFile,
    netLog,
    syncLog,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      SEALANT_AGENT_HOST: "boat",
      SEALANT_AGENT_DAEMON_NAMESPACE: "none",
      SEALANT_AGENT_BOOT_ID_FILE: bootIdFile,
      SEALANT_AGENT_DATA_DIR: dataDir,
      SEALANT_AGENT_MANIFEST_FILE: manifestFile,
      SEALANT_MICROVM_AGENT_STATE_DIR: stateDir,
      SEALANT_MICROVM_AGENT_PORT: "0",
      SEALANT_CONTROL_SOCKET: socketPath,
      SEALANT_MICROVM_SEALANTD: path.join(bin, "sealantd"),
      SEALANT_MICROVM_SEALANTCTL: path.join(bin, "sealantctl"),
      SEALANT_AGENT_IP: path.join(bin, "ip"),
      SEALANT_AGENT_WG: path.join(bin, "wg"),
      SEALANT_AGENT_IPTABLES: path.join(bin, "iptables"),
      SEALANT_AGENT_UNSHARE: path.join(bin, "unshare"),
      SEALANT_AGENT_SYNC: path.join(bin, "sync"),
      SEALANT_AGENT_RESOLV_CONF: resolvConf,
      SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
      SEALANT_AGENT_DNS_PROBE_PORT: String(dnsPort),
      SEALANT_AGENT_DNS_LISTEN_HOST: "127.0.0.1",
      SEALANT_AGENT_DNS_LISTEN_PORT: "0",
      SEALANT_MICROVM_RECOVERY_SETTLE_MS: "3000",
      FAKE_SEALANTD_RECORD: recordFile,
    },
    bootId: async () => (await readFile(bootIdFile, "utf8")).trim(),
    reboot: async () => {
      const next = randomUUID();
      await writeFile(bootIdFile, `${next}\n`);
      return next;
    },
    setHandshake: async (line) => {
      await writeFile(handshakeFile, `${line}\n`);
    },
  };
  vms.add(vm);
  return vm;
};
const startAgent = async (vm: Vm, extraEnv: Record<string, string> = {}): Promise<Agent> => {
  const child = spawn(process.execPath, [AGENT], {
    env: { ...process.env, ...vm.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /listening on :(\d+)/.exec(output);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => reject(new Error(`agent exited early (${code}): ${output}`)));
  });
  const agent: Agent = { vm, child, port };
  agents.add(agent);
  return agent;
};
const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
const stopAgent = async (agent: Agent): Promise<void> => {
  agents.delete(agent);
  agent.child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited(agent.child).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    agent.child.kill("SIGKILL");
    await exited(agent.child);
  }
};
const killRecordedDaemons = async (vm: Vm) => {
  const pids = await readFile(`${vm.recordFile}.pids`, "utf8").catch(() => "");
  for (const pid of pids
    .split("\n")
    .map(Number)
    .filter((value) => value > 1)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
};
const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A DNS answer: the question echoed, one A record with the gateway address. */
const answer = (query: Buffer): Buffer | null => {
  if (query.length < 12) return null;
  let cursor = 12;
  while (cursor < query.length && (query[cursor] ?? 0) !== 0) cursor += (query[cursor] ?? 0) + 1;
  const question = query.subarray(12, cursor + 1 + 4);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0);
  rr.writeUInt16BE(1, 2);
  rr.writeUInt16BE(1, 4);
  rr.writeUInt32BE(30, 6);
  rr.writeUInt16BE(4, 10);
  Buffer.from(BOAT_AGENT_GATEWAY_ADDRESS.split(".").map(Number)).copy(rr, 12);
  return Buffer.concat([header, question, rr]);
};
/** A fake gateway resolver answering any A question with the gateway address, over UDP and TCP. */
const startFakeDns = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const tcp = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 2) return;
      const length = pending.readUInt16BE(0);
      if (pending.length < 2 + length) return;
      const reply = answer(pending.subarray(2, 2 + length));
      if (reply === null) return;
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(reply.length, 0);
      socket.end(Buffer.concat([prefix, reply]));
    });
  });
  const udp = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const address = tcp.address();
  if (typeof address !== "object" || address === null) throw new Error("no tcp address");
  await new Promise<void>((resolve) => udp.bind(address.port, "127.0.0.1", resolve));
  udp.on("message", (message, remote) => {
    const reply = answer(message);
    if (reply !== null) udp.send(reply, remote.port, remote.address);
  });
  return {
    port: address.port,
    close: async () => {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    },
  };
};

// ---- Core's side ---------------------------------------------------------------------------

const target = (bootId: string): BoatExecutionTarget =>
  boatExecutionTargetSchema.parse({
    deploymentId: "dep-1",
    workspaceId: "workspace",
    runId: "run_abc-1",
    runtimeInstanceId: "run_abc-1",
    launchAttemptId: "11111111-1111-4111-8111-111111111111",
    sourceId: "source",
    sandboxId: "bx_23456789",
    diskLineage: "disk-1",
    bootId,
    manifestDigest: MANIFEST_DIGEST,
  });
const labelsOf = (t: BoatExecutionTarget) => ({
  "sealant-runtime": "boat",
  "sealant-deployment": t.deploymentId,
  "sealant-workspace": t.workspaceId,
  "sealant-run": t.runId,
  "sealant-instance": t.runtimeInstanceId,
  "sealant-attempt": t.launchAttemptId,
  "sealant-source": t.sourceId,
});
const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const material = (): Redacted.Redacted<BoatLaunchMaterial> =>
  Redacted.make({
    bootEnv: {
      SEALANT_WORKSPACE_SOURCE: "capture",
      SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
      MEND_SESSION_ID: "1",
    },
    secretEnv: { SEALANT_CAPTURE_TOKEN: "mst_secret" },
    pins: { credentialVersions: [], dotfiles: [] },
    docker: false,
  });
const receipts = { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) };
const wireguardKey = () => {
  const bytes = randomBytes(32);
  bytes[0] = (bytes[0] ?? 0) & 248;
  bytes[31] = ((bytes[31] ?? 0) & 127) | 64;
  return bytes.toString("base64");
};

/** The provider edge: the bind CLI runs locally with the VM's environment; the hosted origin is fixed. */
const providerApi = (
  vm: Vm,
  t: BoatExecutionTarget,
): Pick<BoatApi, "get" | "execute" | "hostControl"> => ({
  get: async () => {
    const sandbox: BoatSandbox = {
      id: boatSandboxIdSchema.parse(t.sandboxId),
      state: "running",
      labels: labelsOf(t),
      autoStop: { kind: "disabled" },
    };
    return { ok: true, value: sandbox };
  },
  execute: async (_id, command) => {
    const prefix = "/usr/bin/sudo -n -- /opt/sealant/node /opt/sealant/boat-bind.mjs '";
    expect(command.startsWith(prefix)).toBe(true);
    const raw = command.slice(prefix.length, -1).replaceAll("'\\''", "'");
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [BIND_CLI, raw],
        { env: { ...process.env, ...vm.env } },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ ok: true, value: { exitCode, timedOut: false, stdout, stderr } });
        },
      );
    });
  },
  hostControl: async () => ({
    ok: true,
    value: { origin: HOSTED_ORIGIN, cookie: secret("local-cookie-only") },
  }),
});

/** The execution store, in memory, with the repository's transition rules that matter here. */
const parseRecord = (value: unknown) =>
  Effect.try({
    try: () => boatExecutionRecordSchema.parse(value),
    catch: () => new BoatExecutionStoreError("invalid-record"),
  });
const memoryRepo = (): BoatExecutionRepo["Service"] => {
  const rows = new Map<string, BoatExecutionRecord>();
  const parse = parseRecord;
  return {
    get: (id) => Effect.succeed(rows.get(id)),
    reserve: (record) =>
      Effect.gen(function* () {
        const parsed = yield* parse(record);
        const saved = rows.get(parsed.target.runtimeInstanceId);
        if (saved === undefined) rows.set(parsed.target.runtimeInstanceId, parsed);
        const now = rows.get(parsed.target.runtimeInstanceId);
        if (now === undefined || !isDeepStrictEqual(now.target, parsed.target))
          return yield* Effect.fail(new BoatExecutionStoreError("target-conflict"));
        return now;
      }),
    advance: (previous, next) =>
      Effect.gen(function* () {
        const parsed = yield* parse(next);
        const saved = rows.get(previous.target.runtimeInstanceId);
        if (!isDeepStrictEqual(saved, previous))
          return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
        rows.set(parsed.target.runtimeInstanceId, parsed);
        return parsed;
      }),
    isolate: (previous, isolation) =>
      Effect.gen(function* () {
        const parsed = yield* parse({ ...previous, isolation });
        rows.set(parsed.target.runtimeInstanceId, parsed);
        return parsed;
      }),
    abort: () => Effect.die("not used"),
    forgetResume: () => Effect.die("not used"),
  };
};

interface Core {
  readonly executor: BoatExecution["Service"];
  readonly repo: BoatExecutionRepo["Service"];
  readonly transport: BoatGuestTransport;
  readonly probe: { healthy: boolean };
}
const realFetch = globalThis.fetch;
const core = async (vm: Vm, t: BoatExecutionTarget, agent: Agent): Promise<Core> => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input).replace(HOSTED_ORIGIN, `http://127.0.0.1:${String(agent.port)}`), init),
  );
  const probe = { healthy: true };
  const runtime = await Effect.runPromise(
    SealantRuntime.pipe(Effect.provide(SealantRuntimeControlLive)),
  );
  const real = createBoatGuestTransport(providerApi(vm, t), runtime);
  // The daemon probe crosses the agent's WebSocket relay into sealantd's own protocol, which the
  // fake daemon does not speak; its refusal path is checked for real below, its answer is stubbed.
  const transport: BoatGuestTransport = {
    ...real,
    probe: async () => ({
      runtimeId: "rt_fixture",
      healthy: probe.healthy,
      supports: ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
    }),
  };
  const repo = memoryRepo();
  const context = await Effect.runPromise(
    Layer.build(
      boatExecutionLayerNoDeps.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(BoatExecutionRepo, repo),
            Layer.succeed(BoatGuestTransportService, transport),
            credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
          ),
        ),
      ),
    ).pipe(Effect.scoped),
  );
  return { executor: Context.get(context, BoatExecution), repo, transport: real, probe };
};
const execute = Effect.runPromise;
const refusalReason = async (effect: Effect.Effect<unknown, unknown>) => {
  const failure = await execute(Effect.flip(effect));
  expect(failure).toBeInstanceOf(BoatExecutionError);
  const diagnostic = boatLaunchDiagnostic(failure, "readiness");
  expect(diagnostic.code).toBe("agent-refused");
  return diagnostic.agent?.reason;
};
const netLines = async (vm: Vm) =>
  (await readFile(vm.netLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
const daemonRecord = async (vm: Vm) =>
  z
    .object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(vm.recordFile, "utf8")));

let dns: Awaited<ReturnType<typeof startFakeDns>> | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([...agents].map(stopAgent));
  for (const vm of vms) {
    await killRecordedDaemons(vm);
    await rm(vm.dir, { recursive: true, force: true });
  }
  vms.clear();
  await dns?.close();
  dns = undefined;
});

/** Bind, seal, isolate and launch through Core's owner against the real agent. */
const launched = async (extraEnv: Record<string, string> = {}) => {
  dns = await startFakeDns();
  const vm = await createVm(dns.port);
  const agent = await startAgent(vm, extraEnv);
  const t = target(await vm.bootId());
  const c = await core(vm, t, agent);
  await execute(c.executor.exchange(t));
  await execute(c.executor.stage(t.runtimeInstanceId, material()));
  const record = await execute(c.repo.get(t.runtimeInstanceId));
  if (record?.admission == null) throw new Error("no admission");
  const gatewayKey = wireguardKey();
  const network = await execute(
    c.executor.isolate(t, {
      network: {
        epoch: record.admission.epoch,
        operationId: record.admission.operationId,
        endpoint: "203.0.113.10",
        subnet: "10.42.7.32/27",
      },
      privateKey: Redacted.make(wireguardKey()),
      publicKey: wireguardKey(),
      gatewayKey,
      port: 40000,
    }),
  );
  await execute(c.executor.recordIsolation(t, { ...receipts, resourceReceipt: network.receipt }));
  await vm.setHandshake(`${gatewayKey}\t1760000000`);
  return { vm, agent, t, c, gatewayKey };
};

describe("Core's Boat execution owner against the real guest agent", () => {
  it("binds through the bind CLI, proves the bearer on health, configures the tunnel, launches and reads readiness", async () => {
    const { vm, t, c } = await launched();
    // The bind left its public record and nothing else on the disk.
    const bind = boatAgentBindRecordSchema.parse(
      JSON.parse(await readFile(path.join(vm.dataDir, "bind.json"), "utf8")),
    );
    expect(bind).toMatchObject({
      boot_id: t.bootId,
      identity: { deployment_id: "dep-1", instance_id: t.sandboxId, disk_lineage: "disk-1" },
    });
    const control = await execute(c.repo.get(t.runtimeInstanceId));
    expect(control?.phase).toBe("installed");
    expect(JSON.stringify(control)).not.toContain(bind.bearer_sha256);
    // The network intent reached wg with the key in the agent's tmpfs key file, never in argv.
    expect(await netLines(vm)).toContainEqual(
      expect.stringMatching(/^wg set sealant-wg private-key \/[^ ]+\/agent\/sealant-wg\.key peer /),
    );
    // Nothing is launched before Core pushes it: readiness says so.
    await expect(execute(c.executor.readiness(t))).rejects.toThrow("invocation-held");
    expect(await execute(c.executor.launch(t.runtimeInstanceId))).toBe("running");
    const launch = boatAgentLaunchRecordSchema.parse(
      JSON.parse(await readFile(path.join(vm.dataDir, "launch.json"), "utf8")),
    );
    expect(launch).toMatchObject({ boot_id: t.bootId, run_id: t.runId });
    await waitFor(() => exists(vm.socketPath));
    const daemon = await daemonRecord(vm);
    expect(daemon.argv).toEqual(["boot"]);
    expect(daemon.env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "capture",
      MEND_SESSION_ID: "1",
      SEALANT_CONTROL_SOCKET: vm.socketPath,
    });
    expect(daemon.env["SEALANT_SECRET_ENV_FILE"]).toBeDefined();
    expect(JSON.parse(await readFile(daemon.env["SEALANT_SECRET_ENV_FILE"] ?? "", "utf8"))).toEqual(
      { SEALANT_CAPTURE_TOKEN: "mst_secret" },
    );
    expect(await execute(c.executor.readiness(t))).toEqual({
      runtimeId: "rt_fixture",
      bootId: t.bootId,
      isolationReceipt: expect.stringMatching(/^[a-f0-9]{64}$/),
      handshake: "verified",
      dns: "udp-and-tcp",
      admission: "held",
    });
    // Running: the launch is the agent's durable record; nothing is pushed or started again.
    expect(await execute(c.executor.launch(t.runtimeInstanceId))).toBe("running");
    const pids = (await readFile(`${vm.recordFile}.pids`, "utf8")).trim().split("\n");
    expect(pids).toHaveLength(1);
  }, 30_000);

  it("adopts a launch whose reply was lost, and refuses a bearer the agent does not hold", async () => {
    const { vm, t, c } = await launched();
    const original = c.transport.request;
    let lost = true;
    const lossy: BoatGuestTransport = {
      ...c.transport,
      request: async (...args) => {
        const reply = await original(...args);
        if (args[2] === "launch" && lost) {
          lost = false;
          throw new Error("lost hosted launch reply");
        }
        return reply;
      },
    };
    const context = await Effect.runPromise(
      Layer.build(
        boatExecutionLayerNoDeps.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(BoatExecutionRepo, c.repo),
              Layer.succeed(BoatGuestTransportService, {
                ...lossy,
                probe: async () => ({ runtimeId: "rt_fixture", healthy: true, supports: [] }),
              }),
              credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
            ),
          ),
        ),
      ).pipe(Effect.scoped),
    );
    const executor = Context.get(context, BoatExecution);
    await expect(execute(executor.launch(t.runtimeInstanceId))).rejects.toThrow(
      "transport-unavailable",
    );
    expect((await execute(c.repo.get(t.runtimeInstanceId)))?.phase).toBe("issued");
    // The agent answers 409 "already booted": the same launch, adopted.
    expect(await execute(executor.launch(t.runtimeInstanceId))).toBe("running");
    await waitFor(() => exists(vm.socketPath));
    expect((await readFile(`${vm.recordFile}.pids`, "utf8")).trim().split("\n")).toHaveLength(1);
    // A wrong bearer is refused by the agent as such, before anything else.
    const hosted = { origin: HOSTED_ORIGIN, cookie: secret("local-cookie-only") };
    const unauthorized = await c.transport.request(hosted, secret("b".repeat(64)), "health").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(unauthorized).toBeInstanceOf(BoatExecutionError);
    if (unauthorized instanceof BoatExecutionError)
      expect(unauthorized.code).toBe("agent-unauthorized");
  }, 30_000);

  it("maps the agent's recovery answers: restarted, nothing-to-save, and the typed refusal of another boot", async () => {
    const { vm, agent, t, c } = await launched({
      FAKE_SEALANTD_EXIT75: "1",
      FAKE_SEALANTD_RECOVERY_EXIT76: "1",
    });
    await execute(c.executor.launch(t.runtimeInstanceId));
    // The daemon exited 75: the agent's health says so, and readiness names the guest failure.
    await waitFor(async () => {
      const failure = await execute(Effect.flip(c.executor.readiness(t)));
      return failure instanceof BoatExecutionError && failure.code === "guest-failed";
    });
    const failure = await execute(Effect.flip(c.executor.readiness(t)));
    // What the daemon printed last comes with it, so a failed boot says why without the VM.
    expect(boatLaunchDiagnostic(failure, "readiness")).toMatchObject({
      code: "guest-failed",
      guest: {
        service: "sealantd",
        exitCode: 75,
        outputTail: "Error: final capture incomplete; exiting with EX_TEMPFAIL",
      },
    });
    await execute(c.executor.hold(t));
    // The recovery boot found nothing to save (exit 76): a distinct outcome, never `held`.
    expect(await execute(c.executor.recover(t))).toEqual({
      outcome: "nothing-to-save",
      basis: "daemon",
      detail: "sealantd boot: nothing to save: never materialized (/workspace/repo)",
    });
    const recovery = await daemonRecord(vm);
    expect(recovery.argv).toEqual(["boot", "--recovery"]);
    expect(
      JSON.parse(await readFile(recovery.env["SEALANT_SECRET_ENV_FILE"] ?? "", "utf8")),
    ).toEqual({
      SEALANT_CAPTURE_TOKEN: "mst_secret",
    });
    // Rebooted: the earlier boot's bearer is answered with a typed refusal, from this agent and
    // from a fresh one, never read as nothing to save.
    await vm.reboot();
    expect(await refusalReason(c.executor.recover(t))).toBe("recover-new-boot");
    await stopAgent(agent);
    const fresh = await startAgent(vm, { FAKE_SEALANTD_EXIT75: "1" });
    const again = await core(vm, t, fresh);
    const record = await execute(c.repo.get(t.runtimeInstanceId));
    if (record === undefined) throw new Error("record");
    await execute(
      again.repo
        .reserve({
          ...record,
          phase: "exchange",
          sealedExchange: "x",
          sealedControl: null,
          admission: null,
          isolation: undefined,
        })
        .pipe(Effect.catch(() => Effect.void)),
    );
    const hosted = { origin: HOSTED_ORIGIN, cookie: secret("local-cookie-only") };
    const bearer = JSON.parse(
      await readFile(path.join(vm.dir, "state", "agent", "arm.json"), "utf8"),
    );
    const refused = await again.transport.request(
      hosted,
      secret(z.object({ bearer: z.string() }).parse(bearer).bearer),
      "recover",
      Redacted.make(
        JSON.stringify({
          version: 1,
          runId: t.runId,
          secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_secret" }),
        }),
      ),
    );
    expect(refused).toEqual({ status: 409, body: { reason: "recover-new-boot" } });
  }, 30_000);

  it("says restarted for a daemon the agent started again in recovery mode", async () => {
    const { vm, t, c } = await launched({ FAKE_SEALANTD_EXIT75: "1" });
    await execute(c.executor.launch(t.runtimeInstanceId));
    await waitFor(async () => {
      const failure = await execute(Effect.flip(c.executor.readiness(t)));
      return failure instanceof BoatExecutionError && failure.code === "guest-failed";
    });
    await execute(c.executor.hold(t));
    expect(await execute(c.executor.recover(t))).toBe("pending");
    await waitFor(async () => (await daemonRecord(vm)).argv.includes("--recovery"));
    await waitFor(() => exists(vm.socketPath));
    // Running again: a second recovery is an observation.
    expect(await execute(c.executor.recover(t))).toBe("running");
  }, 30_000);

  it("parks the held workspace once per operation, mapping the agent's receipt file into custody", async () => {
    const { vm, t, c } = await launched();
    await execute(c.executor.launch(t.runtimeInstanceId));
    await waitFor(() => exists(vm.socketPath));
    await execute(c.executor.hold(t));
    const operationId = randomUUID();
    const receipt = await execute(c.executor.park(t, operationId));
    const file = path.join(vm.dataDir, `park-${operationId}.json`);
    const bytes = await readFile(file);
    expect(receipt).toEqual({
      operationId,
      capsuleHash: sha256(bytes),
      archiveHash: sha256(bytes),
      contentBytes: bytes.length,
      storedBytes: bytes.length,
      entries: 1,
    });
    expect(boatAgentParkReceiptSchema.parse(JSON.parse(bytes.toString("utf8")))).toMatchObject({
      operation_id: operationId,
      boot_id: t.bootId,
      run_id: t.runId,
      daemon: "stopped",
      docker: "absent",
    });
    expect((await readFile(vm.syncLog, "utf8")).trim()).toBe("sync");
    // The same park again is the same receipt; another operation, a launch or a recovery after
    // the park are refused as `parked`.
    expect(await execute(c.executor.park(t, operationId))).toEqual(receipt);
    expect(await refusalReason(c.executor.park(t, randomUUID()))).toBe("parked");
    expect(await refusalReason(c.executor.recover(t))).toBe("parked");
  }, 30_000);

  it("keeps the control relay's refusal typed until the daemon answers on its socket", async () => {
    dns = await startFakeDns();
    const vm = await createVm(dns.port);
    const agent = await startAgent(vm, { FAKE_SEALANTD_EXIT75: "1" });
    const t = target(await vm.bootId());
    const c = await core(vm, t, agent);
    await execute(c.executor.exchange(t));
    const arm = z
      .object({ bearer: z.string() })
      .parse(JSON.parse(await readFile(path.join(vm.dir, "state", "agent", "arm.json"), "utf8")));
    const failure = await c.transport
      .probe(
        { origin: `http://127.0.0.1:${String(agent.port)}`, cookie: secret("local-cookie-only") },
        secret(arm.bearer),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(BoatExecutionError);
    expect(boatLaunchDiagnostic(failure, "readiness")).toEqual({
      step: "readiness",
      errorClass: "TransportError",
      code: "transport-unavailable",
      control: { operation: "open", status: 503, reason: "control-unavailable" },
    });
  }, 30_000);
});
