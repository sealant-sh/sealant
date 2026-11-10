/**
 * The guest agent (`microvm-image/agent.mjs`) in its Boat host mode (`SEALANT_AGENT_HOST=boat`),
 * spawned for real against a fake VM: a boot-id file the test can "reboot", a fake `sealantd`
 * (records argv + env, echoes on the control socket, can exit 75/76), fake `ip`/`wg`/`iptables`
 * (record argv and stdin), a fake `unshare`, a fake `sync`, and a local fake DNS server for the
 * readiness probe. The bind CLI (`microvm-image/boat-bind.mjs`) runs the way Core runs it.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import dgram from "node:dgram";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, ManagedRuntime, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import { MICROVM_AGENT_FILES } from "../../images/microvm/recipe.js";
import {
  AGENT_CONTROL_ROUTE,
  AGENT_HEALTH_ROUTE,
  AGENT_LAUNCH_ROUTE,
  AGENT_RECOVER_ROUTE,
  HOOK_ROUTE_PREFIX,
} from "../microvm/agent-contract.js";
import {
  BOAT_AGENT_CLIENT_ADDRESS,
  BOAT_AGENT_FILES,
  BOAT_AGENT_GATEWAY_ADDRESS,
  BOAT_AGENT_NETWORK_ROUTE,
  BOAT_AGENT_TUNNEL_ROUTE,
  BOAT_AGENT_PARK_ROUTE,
  BOAT_AGENT_WIREGUARD_INTERFACE,
  boatAgentBindRecordSchema,
  boatAgentBindReplySchema,
  boatAgentLaunchEnvRecordSchema,
  boatAgentLaunchRecordSchema,
  boatAgentNetworkResponseSchema,
  boatAgentNetworkStatusSchema,
  boatAgentParkReceiptSchema,
  boatAgentParkResponseSchema,
  boatAgentRecoverResponseSchema,
  boatAgentRefusalSchema,
  type BoatAgentBindRequest,
} from "./agent-contract.js";
import { BoatTunnelCarrier, makeBoatTunnelCarrierLayer } from "./tunnel-carrier.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT = path.join(PACKAGE_ROOT, "microvm-image/agent.mjs");
const BIND_CLI = path.join(PACKAGE_ROOT, "microvm-image/boat-bind.mjs");

const FAKE_SEALANTD = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.env.SEALANT_CONTROL_SOCKET;
const record = process.env.FAKE_SEALANTD_RECORD;
fs.writeFileSync(record + ".tmp", JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  pid: process.pid,
  launchRecordPresent: fs.existsSync(process.env.FAKE_LAUNCH_RECORD),
}));
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

const FAKE_SEALANTCTL = `#!/bin/sh
exit 0
`;

// ip / wg / iptables: one line per invocation (<name> <argv>), and wg's key file kept apart (as
// the real wg, it opens the file named after `private-key` by path; it never reads fd 0). The
// agent runs these with a bare environment (PATH and LANG only, as the Python guest did), so the
// log path is baked into each VM's script, and `wg show` answers with whatever the test put in
// the handshake file (`wg show <if> transfer`: the transfer file beside it).
const fakeNetTool = (log: string, handshakeFile: string) => `#!/bin/sh
name=$(basename "$0")
printf '%s %s\\n' "$name" "$*" >> ${JSON.stringify(log)}
if [ "$name" = wg ]; then
  case "$1" in
    set) shift 2; [ "$1" = private-key ] && cat "$2" > ${JSON.stringify(`${log}.wg-key`)} ;;
    show) case "$3" in
      transfer) cat ${JSON.stringify(`${handshakeFile}.transfer`)} 2>/dev/null ;;
      listen-port) cat ${JSON.stringify(`${handshakeFile}.listen-port`)} 2>/dev/null ;;
      *) cat ${JSON.stringify(handshakeFile)} 2>/dev/null ;;
    esac ;;
  esac
fi
case "$name" in *-restore) cat > ${JSON.stringify(log)}."$name-stdin" ;; esac
if [ -e ${JSON.stringify(log)}."slow-$name" ]; then sleep 6; fi
if [ -e ${JSON.stringify(log)}."fail-$name" ]; then exit 1; fi
if [ -e ${JSON.stringify(log)}."fail-$name-\${1:-}" ]; then exit 1; fi
exit 0
`;

const FAKE_UNSHARE = `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_UNSHARE_LOG"
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

// systemd-run --scope: its own arguments (up to \`--\`) are recorded, then the command is exec'd
// in place, as the real one does once the scope is registered.
const FAKE_SYSTEMD_RUN = `#!/bin/sh
args=""
while [ "$1" != "--" ]; do args="$args $1"; shift; done
shift
printf '%s\\n' "\${args# }" > "$FAKE_SYSTEMD_RUN_LOG"
exec "$@"
`;

// systemd's answer for a slice: it nests by name (\`sealant-docker.slice\` is
// /sealant.slice/sealant-docker.slice), and \`start\` realizes its cgroup, here under the scratch
// cgroup root, as an empty one. The daemon's scope (\`sealant-workspace-<id>.scope\`) is "active"
// while the \`scope-live\` file names its id; \`kill\` ends it unless \`scope-sticky\` is there (a
// scope whose processes will not die). Every call is logged.
const fakeSystemctl = (dir: string) => `#!/bin/sh
for unit; do :; done
printf '%s\\n' "$*" >> ${JSON.stringify(path.join(dir, "systemctl.log"))}
live=${JSON.stringify(path.join(dir, "scope-live"))}
sticky=${JSON.stringify(path.join(dir, "scope-sticky"))}
case "$1" in
  start)
    slice="$SEALANT_MICROVM_CGROUP_ROOT/sealant.slice/$unit"
    mkdir -p "$slice"
    [ -e "$slice/cgroup.events" ] || printf 'populated 0\\nfrozen 0\\n' > "$slice/cgroup.events" ;;
  show)
    case "$unit" in
      *.scope) printf '/sealant-workspace.slice/%s\\n' "$unit" ;;
      *) printf '/sealant.slice/%s\\n' "$unit" ;;
    esac ;;
  list-units)
    [ -e "$live" ] && printf 'sealant-workspace-%s.scope loaded active running unshare\\n' "$(cat "$live")" ;;
  kill)
    [ -e "$sticky" ] || rm -f "$live" ;;
esac
exit 0
`;

const fakeSync = (log: string) => `#!/bin/sh
printf 'sync\\n' >> ${JSON.stringify(log)}
exit 0
`;

// With FAKE_DOCKERD_SHIM, dockerd leaves what a real one does after its group is killed: a shim
// in a session of its own that ignores SIGTERM (an ignored signal survives exec).
const FAKE_DOCKERD = `#!/bin/sh
trap 'exit 0' TERM
[ -n "$FAKE_DOCKERD_ARGS" ] && printf '%s\\n' "$*" > "$FAKE_DOCKERD_ARGS"
if [ -n "$FAKE_DOCKERD_SHIM" ]; then
  setsid sh -c 'trap "" TERM; exec "$0" $FAKE_DOCKERD_SHIM_ARGS' "$FAKE_DOCKERD_SHIM" </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_DOCKERD_SHIM.pid"
fi
while :; do sleep 1; done
`;

// The bundle's own containerd: makes the socket its config names, as the real one listens.
const FAKE_CONTAINERD = `#!/bin/sh
if [ "$1" = --version ]; then echo "containerd v2.9.9-fake"; exit 0; fi
trap 'exit 0' TERM
address=$(sed -n 's/^ *address = "\\(.*\\)"$/\\1/p' "$2")
: > "$address"
while :; do sleep 1; done
`;

// Logs every call; \`ps\` lists FAKE_DOCKER_PS (one container id) when set.
const FAKE_DOCKER = `#!/bin/sh
[ -n "$FAKE_DOCKER_LOG" ] && printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in *" ps "*) [ -n "$FAKE_DOCKER_PS" ] && printf '%s\\n' "$FAKE_DOCKER_PS" ;; esac
exit 0
`;

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const MANIFEST_DIGEST = createHash("sha256").update("boat image manifest").digest("hex");
const IDENTITY = {
  deployment_id: "dep-1",
  instance_id: "inst-1",
  disk_lineage: "disk-1",
};

interface Vm {
  readonly dir: string;
  readonly bin: string;
  readonly bootIdFile: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly manifestFile: string;
  readonly socketPath: string;
  readonly recordFile: string;
  readonly netLog: string;
  readonly unshareLog: string;
  readonly systemdRunLog: string;
  readonly systemctlLog: string;
  readonly syncLog: string;
  readonly resolvConf: string;
  readonly dockerDir: string;
  readonly cgroupRoot: string;
  readonly env: Record<string, string>;
  readonly bootId: () => Promise<string>;
  readonly reboot: () => Promise<string>;
  /** What the fake `wg show sealant-wg latest-handshakes` prints from now on. */
  readonly setHandshake: (line: string) => Promise<void>;
  /**
   * What the fake `systemctl` says of the daemon's scope: `sealant-workspace-<id>.scope` is
   * active while `id` is a string; `sticky` keeps it so through a `kill`. `null` ends it.
   */
  readonly setScope: (id: string | null, options?: { readonly sticky?: boolean }) => Promise<void>;
  /** What `wg show <if> transfer` prints: `<peer key>\t<received>\t<sent>`. */
  readonly setTransfer: (line: string) => Promise<void>;
}

interface Agent {
  readonly vm: Vm;
  readonly child: ChildProcess;
  readonly port: number;
  readonly output: () => string;
}

const vms = new Set<Vm>();
const agents = new Set<Agent>();

const writeExecutable = async (file: string, content: string) => {
  await writeFile(file, content);
  await chmod(file, 0o755);
};

const createVm = async (): Promise<Vm> => {
  const dir = await mkdtemp(path.join(tmpdir(), "boat-agent-"));
  const bin = path.join(dir, "bin");
  const etc = path.join(dir, "etc");
  await mkdir(bin);
  await mkdir(etc);
  const netLog = path.join(dir, "net.log");
  const syncLog = path.join(dir, "sync.log");
  const handshakeFile = path.join(dir, "wg-handshake");
  await Promise.all([
    writeExecutable(path.join(bin, "sealantd"), FAKE_SEALANTD),
    writeExecutable(path.join(bin, "sealantctl"), FAKE_SEALANTCTL),
    writeExecutable(path.join(bin, "ip"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "wg"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "iptables"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "iptables-restore"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "ip6tables"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "ip6tables-restore"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "unshare"), FAKE_UNSHARE),
    writeExecutable(path.join(bin, "systemd-run"), FAKE_SYSTEMD_RUN),
    writeExecutable(path.join(bin, "sync"), fakeSync(syncLog)),
    writeExecutable(path.join(bin, "systemctl"), fakeSystemctl(dir)),
    writeExecutable(path.join(bin, "modprobe"), fakeNetTool(netLog, handshakeFile)),
    writeExecutable(path.join(bin, "dockerd"), FAKE_DOCKERD),
    writeExecutable(path.join(bin, "docker"), FAKE_DOCKER),
    writeExecutable(path.join(bin, "containerd"), FAKE_CONTAINERD),
    writeExecutable(
      path.join(bin, "containerd-shim-runc-v2"),
      "#!/bin/sh\necho shim v2.9.9-fake\n",
    ),
    writeExecutable(path.join(bin, "docker-init"), "#!/bin/sh\nexit 0\n"),
  ]);
  const bootIdFile = path.join(dir, "boot_id");
  await writeFile(bootIdFile, `${randomUUID()}\n`);
  // The engine's cgroup as the kernel makes it on mkdir (an empty one), and bridge netfilter off.
  const engineCgroup = path.join(dir, "cgroup", "sealant-docker-engine");
  await mkdir(engineCgroup, { recursive: true });
  await writeFile(path.join(engineCgroup, "cgroup.events"), "populated 0\nfrozen 0\n");
  const procSys = path.join(dir, "proc-sys");
  await mkdir(path.join(procSys, "net", "bridge"), { recursive: true });
  for (const name of ["bridge-nf-call-iptables", "bridge-nf-call-ip6tables"]) {
    await writeFile(path.join(procSys, "net", "bridge", name), "0\n");
  }
  const dataDir = path.join(dir, "data");
  const stateDir = path.join(dir, "state");
  const manifestFile = path.join(dir, "manifest.json");
  await writeFile(manifestFile, JSON.stringify({ digest: MANIFEST_DIGEST }));
  // The VM's resolv.conf is the systemd-resolved stub symlink, as on a stock image.
  await writeFile(path.join(etc, "stub-resolv.conf"), "nameserver 127.0.0.53\n");
  const resolvConf = path.join(etc, "resolv.conf");
  await symlink(path.join(etc, "stub-resolv.conf"), resolvConf);
  const socketPath = path.join(dir, "control.sock");
  const recordFile = path.join(dir, "sealantd-record.json");
  const unshareLog = path.join(dir, "unshare.log");
  const systemdRunLog = path.join(dir, "systemd-run.log");
  const systemctlLog = path.join(dir, "systemctl.log");
  const dockerDir = path.join(dir, "docker");
  const vm: Vm = {
    dir,
    bin,
    bootIdFile,
    dataDir,
    stateDir,
    manifestFile,
    socketPath,
    recordFile,
    netLog,
    unshareLog,
    systemdRunLog,
    systemctlLog,
    syncLog,
    resolvConf,
    dockerDir,
    cgroupRoot: path.join(dir, "cgroup"),
    env: {
      SEALANT_AGENT_HOST: "boat",
      SEALANT_AGENT_DAEMON_NAMESPACE: "none",
      SEALANT_AGENT_BOOT_ID_FILE: bootIdFile,
      SEALANT_AGENT_DATA_DIR: dataDir,
      SEALANT_AGENT_MANIFEST_FILE: manifestFile,
      SEALANT_MICROVM_AGENT_STATE_DIR: stateDir,
      SEALANT_CONTROL_SOCKET: socketPath,
      SEALANT_MICROVM_SEALANTD: path.join(bin, "sealantd"),
      SEALANT_MICROVM_SEALANTCTL: path.join(bin, "sealantctl"),
      SEALANT_AGENT_IP: path.join(bin, "ip"),
      SEALANT_AGENT_WG: path.join(bin, "wg"),
      SEALANT_AGENT_IPTABLES: path.join(bin, "iptables"),
      SEALANT_AGENT_IPTABLES_RESTORE: path.join(bin, "iptables-restore"),
      SEALANT_AGENT_IP6TABLES: path.join(bin, "ip6tables"),
      SEALANT_AGENT_IP6TABLES_RESTORE: path.join(bin, "ip6tables-restore"),
      SEALANT_AGENT_UNSHARE: path.join(bin, "unshare"),
      SEALANT_AGENT_SYSTEMD_RUN: path.join(bin, "systemd-run"),
      SEALANT_AGENT_SYNC: path.join(bin, "sync"),
      SEALANT_AGENT_SYSTEMCTL: path.join(bin, "systemctl"),
      SEALANT_AGENT_MODPROBE: path.join(bin, "modprobe"),
      SEALANT_AGENT_PROC_SYS: path.join(dir, "proc-sys"),
      SEALANT_AGENT_RESOLV_CONF: resolvConf,
      // The VM's resolver on a loopback port of its own (the tunnel's address is not here).
      SEALANT_AGENT_DNS_LISTEN_HOST: "127.0.0.1",
      SEALANT_AGENT_DNS_LISTEN_PORT: "0",
      SEALANT_MICROVM_RECOVERY_SETTLE_MS: "3000",
      SEALANT_MICROVM_DOCKERD: path.join(bin, "dockerd"),
      SEALANT_MICROVM_DOCKER: path.join(bin, "docker"),
      SEALANT_MICROVM_CONTAINERD: path.join(bin, "containerd"),
      SEALANT_MICROVM_CONTAINERD_SHIM: path.join(bin, "containerd-shim-runc-v2"),
      SEALANT_MICROVM_DOCKER_INIT: path.join(bin, "docker-init"),
      SEALANT_MICROVM_DOCKER_SOCKET: path.join(dockerDir, "run", "docker.sock"),
      SEALANT_MICROVM_DOCKER_DATA_ROOT: path.join(dockerDir, "data"),
      SEALANT_MICROVM_DOCKER_EXEC_ROOT: path.join(dockerDir, "exec"),
      SEALANT_MICROVM_DOCKER_PID_FILE: path.join(dockerDir, "docker.pid"),
      SEALANT_MICROVM_DOCKER_LOG: path.join(dockerDir, "dockerd.stderr.log"),
      SEALANT_MICROVM_DOCKER_PROBE_INTERVAL_MS: "20",
      // Boat's Docker cgroups, under a scratch mount point: the test is not root.
      SEALANT_MICROVM_CGROUP_ROOT: path.join(dir, "cgroup"),
      SEALANT_MICROVM_DOCKER_SHUTDOWN_TIMEOUT_MS: "500",
      FAKE_SEALANTD_RECORD: recordFile,
      FAKE_LAUNCH_RECORD: path.join(dataDir, "launch.json"),
      FAKE_UNSHARE_LOG: unshareLog,
      FAKE_SYSTEMD_RUN_LOG: systemdRunLog,
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
    setScope: async (id, options = {}) => {
      const live = path.join(dir, "scope-live");
      const sticky = path.join(dir, "scope-sticky");
      if (id === null) {
        await rm(live, { force: true });
        await rm(sticky, { force: true });
        return;
      }
      await writeFile(live, id);
      if (options.sticky === true) await writeFile(sticky, "");
      else await rm(sticky, { force: true });
    },
    setTransfer: async (line) => {
      await writeFile(`${handshakeFile}.transfer`, `${line}\n`);
    },
  };
  vms.add(vm);
  return vm;
};

const startAgent = async (
  vm: Vm,
  extraEnv: Record<string, string> = {},
  agentPath: string = AGENT,
): Promise<Agent> => {
  const child = spawn(process.execPath, [agentPath], {
    env: {
      ...process.env,
      PATH: `${vm.bin}:${process.env["PATH"] ?? ""}`,
      SEALANT_MICROVM_AGENT_PORT: "0",
      ...vm.env,
      ...extraEnv,
    },
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
  const agent: Agent = { vm, child, port, output: () => output };
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

/** The agent killed outright (SIGKILL), as a crash would: nothing it started is stopped. */
const crashAgent = async (agent: Agent): Promise<void> => {
  agents.delete(agent);
  agent.child.kill("SIGKILL");
  await exited(agent.child);
};

/**
 * Every daemon the fake sealantd recorded, and every dockerd that joined the fake engine cgroup
 * (its pid is what the wrapper wrote to `cgroup.procs`): an agent crashed by a test leaves them.
 */
const killRecordedDaemons = async (vm: Vm) => {
  const recorded = await readFile(`${vm.recordFile}.pids`, "utf8").catch(() => "");
  const engine = await readFile(
    path.join(vm.cgroupRoot, "sealant-docker-engine", "cgroup.procs"),
    "utf8",
  ).catch(() => "");
  for (const pid of `${recorded}\n${engine}`
    .split("\n")
    .map(Number)
    .filter((value) => value > 1)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
};

afterEach(async () => {
  await Promise.all([...agents].map(stopAgent));
  for (const vm of vms) {
    await killRecordedDaemons(vm);
    await rm(vm.dir, { recursive: true, force: true });
  }
  vms.clear();
});

const call = async (
  agent: Agent,
  method: string,
  route: string,
  options: { readonly body?: unknown; readonly bearer?: string } = {},
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`http://127.0.0.1:${agent.port}${route}`, {
    method,
    headers: {
      ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
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

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// --------------------------------------------------------------------------------------------
// Bind CLI
// --------------------------------------------------------------------------------------------

const bindRequest = async (
  vm: Vm,
  overrides: Partial<BoatAgentBindRequest> = {},
): Promise<BoatAgentBindRequest> => ({
  format: "sealant-bootstrap-v1",
  identity: IDENTITY,
  boot_id: await vm.bootId(),
  manifest_digest: MANIFEST_DIGEST,
  operation_id: "op-1",
  public_key: TEST_KEY.publicKey,
  ...overrides,
});

/** `sudo -n node boat-bind.mjs '<json>'` as Core runs it (without the sudo). */
const runBind = (
  vm: Vm,
  request: unknown,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIND_CLI, JSON.stringify(request)],
      { env: { ...process.env, ...vm.env } },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : error.code === undefined
                ? 1
                : Number(error.code);
        resolve({ code, stdout, stderr });
      },
    );
  });

const decryptBearer = (request: BoatAgentBindRequest, ciphertext: string): string => {
  const label = JSON.stringify([
    request.format,
    request.identity.deployment_id,
    request.identity.instance_id,
    request.identity.disk_lineage,
    request.boot_id,
    request.operation_id,
    request.manifest_digest,
  ]);
  return privateDecrypt(
    {
      key: TEST_KEY.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
      oaepLabel: Buffer.from(label),
    },
    Buffer.from(ciphertext, "base64"),
  ).toString("utf8");
};

/** Bind the VM on its current boot and return the bearer Core would hold. */
const bindVm = async (vm: Vm, operationId = "op-1"): Promise<string> => {
  const request = await bindRequest(vm, { operation_id: operationId });
  const result = await runBind(vm, request);
  expect(result, result.stderr).toMatchObject({ code: 0 });
  const reply = boatAgentBindReplySchema.parse(JSON.parse(result.stdout));
  const bearer = decryptBearer(request, reply.ciphertext);
  expect(bearer).toMatch(/^[a-f0-9]{64}$/);
  return bearer;
};

const launchBody = (bearer: string, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  runId: "run_abc-1",
  controlToken: bearer,
  flushTimeoutMs: 400,
  bootEnv: {
    SEALANT_WORKSPACE_SOURCE: "capture",
    SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
    MEND_SESSION_ID: "1",
  },
  secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_secret" }),
  ...overrides,
});

const recoverBody = {
  version: 1,
  runId: "run_abc-1",
  secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_recovery_token" }),
};

const daemonRecordSchema = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  pid: z.number().int(),
  launchRecordPresent: z.boolean(),
});

const readDaemonRecord = async (vm: Vm) => {
  await waitFor(async () => {
    const raw = await readFile(vm.recordFile, "utf8").catch(() => null);
    if (raw === null) return false;
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  });
  return daemonRecordSchema.parse(JSON.parse(await readFile(vm.recordFile, "utf8")));
};

const launched = async (vm: Vm, extraEnv: Record<string, string> = {}) => {
  const bearer = await bindVm(vm);
  const agent = await startAgent(vm, extraEnv);
  const accepted = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
    body: launchBody(bearer),
    bearer,
  });
  expect(accepted).toMatchObject({ status: 200, body: { outcome: "booting" } });
  return { agent, bearer };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const daemonExitCode = async (agent: Agent, bearer: string): Promise<number | null> => {
  const health = await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer });
  const parsed = z.object({ daemonExit: z.object({ code: z.number().nullable() }).optional() });
  return parsed.parse(health.body).daemonExit?.code ?? null;
};

describe("boat agent · host mode", () => {
  it("answers no Lambda hook and refuses a launch before the VM is bound", async () => {
    const vm = await createVm();
    const agent = await startAgent(vm);
    expect((await call(agent, "POST", `${HOOK_ROUTE_PREFIX}/ready`, { body: {} })).status).toBe(
      404,
    );
    expect(
      (await call(agent, "POST", `${HOOK_ROUTE_PREFIX}/run`, { body: { runHookPayload: "{}" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchBody("x"), bearer: "x" }))
        .status,
    ).toBe(503);
    expect((await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer: "x" })).status).toBe(401);
  });

  it.each([
    { host: "lambda", files: MICROVM_AGENT_FILES.map((file) => `microvm-image/${file}`) },
    { host: "boat", files: [...BOAT_AGENT_FILES] },
  ])("starts the $host agent from exactly the files its image ships", async ({ host, files }) => {
    const vm = await createVm();
    const shipped = path.join(vm.dir, `shipped-${host}`);
    await mkdir(shipped);
    for (const file of files) {
      await copyFile(path.join(PACKAGE_ROOT, file), path.join(shipped, path.basename(file)));
    }
    const agent = await startAgent(
      vm,
      { SEALANT_AGENT_HOST: host },
      path.join(shipped, "agent.mjs"),
    );
    expect(agent.port).toBeGreaterThan(0);
  });
});

describe("boat agent · bind", () => {
  it("answers the bootstrap wire Core parses, and the bearer arms the agent", async () => {
    const vm = await createVm();
    const request = await bindRequest(vm);
    const result = await runBind(vm, request);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    const reply = boatAgentBindReplySchema.parse(JSON.parse(result.stdout));
    expect(reply).toMatchObject({
      identity: IDENTITY,
      boot_id: request.boot_id,
      operation_id: "op-1",
      admission: "held",
      boot: { status: "compatible" },
    });
    const bearer = decryptBearer(request, reply.ciphertext);
    expect(bearer).toMatch(/^[a-f0-9]{64}$/);
    // The bearer never appears in the reply, the public record or the CLI's output.
    expect(result.stdout).not.toContain(bearer);
    const record = boatAgentBindRecordSchema.parse(
      JSON.parse(await readFile(path.join(vm.dataDir, "bind.json"), "utf8")),
    );
    expect(record).toEqual({
      format: "sealant-agent-bind-v1",
      boot_id: request.boot_id,
      identity: IDENTITY,
      operation_id: "op-1",
      public_key_sha256: sha256(TEST_KEY.publicKey),
      // A digest only: the disk never holds the bearer itself.
      bearer_sha256: sha256(bearer),
    });
    expect(await readFile(path.join(vm.dataDir, "bind.json"), "utf8")).not.toContain(bearer);
    const armFile = path.join(vm.stateDir, "agent", "arm.json");
    expect((await stat(armFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(armFile, "utf8")).toContain(bearer);
    expect((await stat(vm.dataDir)).mode & 0o777).toBe(0o700);

    // An agent started after the bind is armed: the bearer authenticates health (not booted yet).
    const agent = await startAgent(vm);
    expect((await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer: "nope" })).status).toBe(401);
    expect(await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).toMatchObject({
      status: 503,
      body: { booted: false },
    });
  });

  it("replays the same exchange with the same bearer and refuses a different one on the same boot", async () => {
    const vm = await createVm();
    const request = await bindRequest(vm);
    const first = await runBind(vm, request);
    const second = await runBind(vm, request);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstReply = boatAgentBindReplySchema.parse(JSON.parse(first.stdout));
    const secondReply = boatAgentBindReplySchema.parse(JSON.parse(second.stdout));
    expect(decryptBearer(request, secondReply.ciphertext)).toBe(
      decryptBearer(request, firstReply.ciphertext),
    );

    const otherOperation = await runBind(vm, { ...request, operation_id: "op-2" });
    expect(otherOperation.code).not.toBe(0);
    expect(otherOperation.stderr.trim()).toBe("bind-exchange-conflict");
    const otherKey = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const otherPublicKey = await runBind(vm, { ...request, public_key: otherKey.publicKey });
    expect(otherPublicKey.code).not.toBe(0);
    expect(otherPublicKey.stderr.trim()).toBe("bind-exchange-conflict");
  });

  it("refuses a manifest the image does not carry, and a boot that is not this one", async () => {
    const vm = await createVm();
    const mismatch = await runBind(vm, await bindRequest(vm, { manifest_digest: "0".repeat(64) }));
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr.trim()).toBe("bind-manifest-mismatch");
    expect(await exists(path.join(vm.dataDir, "bind.json"))).toBe(false);

    const stale = await runBind(vm, await bindRequest(vm, { boot_id: randomUUID() }));
    expect(stale.code).not.toBe(0);
    expect(stale.stderr.trim()).toBe("bind-stale-boot");

    await rm(vm.manifestFile);
    const absent = await runBind(vm, await bindRequest(vm));
    expect(absent.code).not.toBe(0);
    expect(absent.stderr.trim()).toBe("bind-manifest-mismatch");

    const malformed = await runBind(vm, { ...(await bindRequest(vm)), extra: true });
    expect(malformed.code).not.toBe(0);
    expect(malformed.stderr.trim()).toBe("bind-invalid-request");
  });

  it("binds a new boot afresh for the same identity and refuses another identity", async () => {
    const vm = await createVm();
    const first = await bindVm(vm);
    await vm.reboot();
    const otherIdentity = await runBind(
      vm,
      await bindRequest(vm, { identity: { ...IDENTITY, instance_id: "inst-2" } }),
    );
    expect(otherIdentity.code).not.toBe(0);
    expect(otherIdentity.stderr.trim()).toBe("bind-identity-conflict");
    const second = await bindVm(vm, "op-2");
    expect(second).not.toBe(first);
    const record = boatAgentBindRecordSchema.parse(
      JSON.parse(await readFile(path.join(vm.dataDir, "bind.json"), "utf8")),
    );
    expect(record.boot_id).toBe(await vm.bootId());
    expect(record.operation_id).toBe("op-2");
  });
});

describe("boat agent · parked resume bind", () => {
  it("binds a VM restored from a parked disk as a new instance of the same deployment, and only then", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    const resumed = { ...IDENTITY, instance_id: "inst-resumed" };

    // Not parked: a restored disk that was never closed keeps its identity.
    await vm.reboot();
    const unparked = await runBind(vm, await bindRequest(vm, { identity: resumed }));
    expect(unparked.stderr.trim()).toBe("bind-identity-conflict");

    // Parked on the bound boot, then restored: one fresh bind as the new instance.
    const parkedVm = await createVm();
    const parkedBearer = await bindVm(parkedVm);
    const parkedAgent = await startAgent(parkedVm);
    const parked = await call(parkedAgent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId: randomUUID() },
      bearer: parkedBearer,
    });
    expect(parked.status).toBe(200);
    await stopAgent(parkedAgent);
    await parkedVm.reboot();
    const otherDeployment = await runBind(
      parkedVm,
      await bindRequest(parkedVm, { identity: { ...resumed, deployment_id: "dep-other" } }),
    );
    expect(otherDeployment.stderr.trim()).toBe("bind-identity-conflict");
    const rebound = await runBind(parkedVm, await bindRequest(parkedVm, { identity: resumed }));
    expect(rebound, rebound.stderr).toMatchObject({ code: 0 });
    const record = boatAgentBindRecordSchema.parse(
      JSON.parse(await readFile(path.join(parkedVm.dataDir, "bind.json"), "utf8")),
    );
    expect(record.identity).toEqual(resumed);
    expect(record.boot_id).toBe(await parkedVm.bootId());
    await stopAgent(agent);
    expect(bearer).not.toBe(parkedBearer);
  });
});

describe("boat agent · launch", () => {
  it("accepts one launch with the bearer, records it before sealantd starts, and keeps the sweep VM-local", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    expect(
      (await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchBody(bearer), bearer: "wrong" }))
        .status,
    ).toBe(401);
    // The control token inside the push must be the bearer itself.
    expect(
      (
        await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
          body: launchBody(bearer, { controlToken: "other" }),
          bearer,
        })
      ).status,
    ).toBe(400);
    expect(await exists(path.join(vm.dataDir, "launch.json"))).toBe(false);

    const accepted = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
      body: launchBody(bearer),
      bearer,
    });
    expect(accepted).toMatchObject({ status: 200, body: { outcome: "booting" } });
    const launchRecord = boatAgentLaunchRecordSchema.parse(
      JSON.parse(await readFile(path.join(vm.dataDir, "launch.json"), "utf8")),
    );
    expect(launchRecord).toMatchObject({ boot_id: await vm.bootId(), run_id: "run_abc-1" });

    const record = await readDaemonRecord(vm);
    expect(record.argv).toEqual(["boot"]);
    expect(record.launchRecordPresent).toBe(true);
    expect(record.env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "capture",
      MEND_SESSION_ID: "1",
      SEALANT_CONTROL_SOCKET: vm.socketPath,
      SEALANT_SECRET_ENV_FILE: path.join(vm.stateDir, "secrets", "env.json"),
    });
    expect(record.env).not.toHaveProperty("SEALANT_SWEEP_EXEMPT_FILE");

    await waitFor(() => exists(vm.socketPath));
    expect(await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).toMatchObject({
      status: 200,
      body: { booted: true, controlSocket: true },
    });
    expect(
      (await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchBody(bearer), bearer })).status,
    ).toBe(409);

    // A fresh agent process on the same boot finds the launch already accepted.
    await stopAgent(agent);
    const restarted = await startAgent(vm);
    expect(
      await call(restarted, "POST", AGENT_LAUNCH_ROUTE, { body: launchBody(bearer), bearer }),
    ).toMatchObject({ status: 409 });
    expect((await call(restarted, "GET", AGENT_HEALTH_ROUTE, { bearer })).status).not.toBe(401);
  });

  it("starts sealantd as PID 1 of its own PID namespace through unshare, in a scope of its own", async () => {
    const vm = await createVm();
    await launched(vm, { SEALANT_AGENT_DAEMON_NAMESPACE: "pid" });
    const record = await readDaemonRecord(vm);
    expect(record.argv).toEqual(["boot"]);
    expect((await readFile(vm.unshareLog, "utf8")).trim()).toBe(
      `--pid --fork --mount-proc --kill-child -- ${path.join(vm.bin, "sealantd")} boot`,
    );
    // The namespace runs in a transient scope under its own slice, where an OOM kill takes one
    // of its processes and never the agent (`OOMPolicy=continue`); the name is fresh per start.
    expect((await readFile(vm.systemdRunLog, "utf8")).trim()).toMatch(
      /^--scope --quiet --collect --unit=sealant-workspace-[0-9a-f]{8} --slice=sealant-workspace --property=OOMPolicy=continue$/,
    );
    expect(record.env).not.toHaveProperty("SEALANT_SWEEP_EXEMPT_FILE");
  });
});

describe("boat agent · recover", () => {
  it("says `running` while the daemon lives, and refuses another run or the wrong token", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    expect(
      (await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer: "wrong" }))
        .status,
    ).toBe(401);
    const running = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(running.status).toBe(200);
    expect(boatAgentRecoverResponseSchema.parse(running.body)).toEqual({ outcome: "running" });
    const conflict = await call(agent, "POST", AGENT_RECOVER_ROUTE, {
      body: { ...recoverBody, runId: "run_other" },
      bearer,
    });
    expect(conflict.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(conflict.body)).toEqual({
      reason: "recover-binding-conflict",
    });
  });

  it("restarts a daemon that exited 75, in recovery mode", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    const recovered = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(recovered.status).toBe(200);
    expect(boatAgentRecoverResponseSchema.parse(recovered.body)).toEqual({ outcome: "restarted" });
    await waitFor(async () => {
      const record = await readDaemonRecord(vm);
      return record.argv.includes("--recovery");
    });
    const record = await readDaemonRecord(vm);
    expect(record.argv).toEqual(["boot", "--recovery"]);
    expect(record.env).not.toHaveProperty("SEALANT_SWEEP_EXEMPT_FILE");
    expect(
      JSON.parse(await readFile(path.join(vm.stateDir, "secrets", "env.json"), "utf8")),
    ).toEqual({ SEALANT_CAPTURE_TOKEN: "mst_recovery_token" });
  });

  it("answers `nothing-to-save` from the daemon (exit 76) and from a bound boot that never launched", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, {
      FAKE_SEALANTD_EXIT75: "1",
      FAKE_SEALANTD_RECOVERY_EXIT76: "1",
    });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    const recovered = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(recovered.status).toBe(200);
    expect(boatAgentRecoverResponseSchema.parse(recovered.body)).toEqual({
      outcome: "nothing-to-save",
      basis: "daemon",
      detail: "sealantd boot: nothing to save: never materialized (/workspace/repo)",
    });

    const idle = await createVm();
    const idleBearer = await bindVm(idle);
    const idleAgent = await startAgent(idle);
    const noLaunch = await call(idleAgent, "POST", AGENT_RECOVER_ROUTE, {
      body: recoverBody,
      bearer: idleBearer,
    });
    expect(noLaunch.status).toBe(200);
    expect(boatAgentRecoverResponseSchema.parse(noLaunch.body)).toEqual({
      outcome: "nothing-to-save",
      basis: "no-launch",
    });
  });

  it("refuses with `recover-new-boot` once the VM has rebooted", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    await vm.reboot();
    const refused = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(refused.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(refused.body)).toEqual({ reason: "recover-new-boot" });
    expect(await readDaemonRecord(vm)).toMatchObject({ argv: ["boot"] });
  });

  it("refuses the earlier boot's bearer with `recover-new-boot` from a fresh agent after a reboot", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    await stopAgent(agent);
    await vm.reboot();
    // The reboot's agent is not armed (the bind is another boot's), yet it must not answer the
    // old bearer with a 401 that reads like a wrong credential.
    const fresh = await startAgent(vm);
    const refused = await call(fresh, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(refused.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(refused.body)).toEqual({ reason: "recover-new-boot" });
    const wrong = await call(fresh, "POST", AGENT_RECOVER_ROUTE, {
      body: recoverBody,
      bearer: "b".repeat(64),
    });
    expect(wrong.status).toBe(401);
  });

  it("refuses with `recover-state-unknown` from a restarted agent that finds no launch environment", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    await stopAgent(agent);
    // The launch record is this boot's, but what a recovery boot starts from is gone from tmpfs.
    await rm(path.join(vm.stateDir, "agent", "launch-env.json"));
    const restarted = await startAgent(vm);
    const refused = await call(restarted, "POST", AGENT_RECOVER_ROUTE, {
      body: recoverBody,
      bearer,
    });
    expect(refused.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(refused.body)).toEqual({
      reason: "recover-state-unknown",
    });
  });
});

describe("boat agent · park", () => {
  it("kills the daemon, syncs, writes a receipt once per operation, and blocks launch and recover", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    const daemon = await readDaemonRecord(vm);
    expect(alive(daemon.pid)).toBe(true);
    const operationId = randomUUID();
    expect(
      (await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, { body: { operationId }, bearer: "no" }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
          body: { format: "sealant-agent-park-v1", operationId: "not-a-uuid" },
          bearer,
        })
      ).status,
    ).toBe(400);

    const parked = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });
    expect(parked.status).toBe(200);
    const response = boatAgentParkResponseSchema.parse(parked.body);
    expect(response.receipt.path).toBe(path.join(vm.dataDir, `park-${operationId}.json`));
    const bytes = await readFile(response.receipt.path);
    expect(response.receipt).toEqual({
      path: response.receipt.path,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
    expect((await stat(response.receipt.path)).mode & 0o777).toBe(0o600);
    expect(boatAgentParkReceiptSchema.parse(JSON.parse(bytes.toString("utf8")))).toMatchObject({
      operation_id: operationId,
      boot_id: await vm.bootId(),
      run_id: "run_abc-1",
      daemon: "stopped",
      docker: "absent",
    });
    await waitFor(async () => !alive(daemon.pid));
    expect((await readFile(vm.syncLog, "utf8")).trim()).toBe("sync");

    const again = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });
    expect(again).toEqual(parked);
    expect((await readFile(vm.syncLog, "utf8")).trim()).toBe("sync");

    const other = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId: randomUUID() },
      bearer,
    });
    expect(other.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(other.body)).toEqual({ reason: "parked" });
    const launch = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
      body: launchBody(bearer),
      bearer,
    });
    expect(launch.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(launch.body)).toEqual({ reason: "parked" });
    const recover = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(recover.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(recover.body)).toEqual({ reason: "parked" });
  });

  it("parks a bound VM that never launched", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    const operationId = randomUUID();
    const parked = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });
    expect(parked.status).toBe(200);
    const response = boatAgentParkResponseSchema.parse(parked.body);
    expect(
      boatAgentParkReceiptSchema.parse(JSON.parse(await readFile(response.receipt.path, "utf8"))),
    ).toMatchObject({ run_id: null, daemon: "stopped", docker: "absent" });
  });
});

// --------------------------------------------------------------------------------------------
// Network
// --------------------------------------------------------------------------------------------

const wireguardKey = () => {
  const bytes = randomBytes(32);
  // Clamp as WireGuard does, so the key is a plausible Curve25519 scalar.
  bytes[0] = (bytes[0] ?? 0) & 248;
  bytes[31] = ((bytes[31] ?? 0) & 127) | 64;
  return bytes.toString("base64");
};

const networkBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: "sealant-guest-network-v1",
  binding: { boot_id: "b", epoch: 1 },
  private_key: wireguardKey(),
  public_key: wireguardKey(),
  gateway_key: wireguardKey(),
  endpoint: "203.0.113.10",
  port: 51820,
  subnet: "10.42.7.32/27",
  ...overrides,
});

const netLines = async (vm: Vm) =>
  (await readFile(vm.netLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

/** A fake gateway resolver: answers any A question with the gateway address, over UDP and TCP. */
/**
 * A zone a fake resolver serves: names (exact, or `*.suffix`) to IPv4 addresses, and the rcode for
 * every other name. The gateway's is its reach network's aliases and SERVFAIL (it has no upstream);
 * a VM's own resolver answers public names and NXDOMAIN.
 */
type FakeZone = { readonly names: Record<string, string>; readonly miss: 2 | 3 };
const questionName = (query: Buffer): string => {
  const labels: string[] = [];
  let cursor = 12;
  while (cursor < query.length && (query[cursor] ?? 0) !== 0) {
    const length = query[cursor] ?? 0;
    labels.push(query.subarray(cursor + 1, cursor + 1 + length).toString("ascii"));
    cursor += length + 1;
  }
  return labels.join(".").toLowerCase();
};
const zoneAddress = (zone: FakeZone, name: string): string | undefined =>
  zone.names[name] ??
  Object.entries(zone.names).find(
    ([pattern]) => pattern.startsWith("*.") && name.endsWith(pattern.slice(1)),
  )?.[1];

const startFakeDns = async (
  behaviour: "answer" | "wrong-ip" | "silent" = "answer",
  zone?: FakeZone,
): Promise<{
  readonly port: number;
  readonly asked: string[];
  readonly close: () => Promise<void>;
}> => {
  const asked: string[] = [];
  const answer = (query: Buffer): Buffer | null => {
    if (behaviour === "silent" || query.length < 12) return null;
    asked.push(questionName(query));
    // Question ends at the terminating root label + 4 bytes of type/class.
    let cursor = 12;
    while (cursor < query.length && (query[cursor] ?? 0) !== 0) cursor += (query[cursor] ?? 0) + 1;
    const questionEnd = cursor + 1 + 4;
    const question = query.subarray(12, questionEnd);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const zoned = zone === undefined ? undefined : zoneAddress(zone, questionName(query));
    if (zone !== undefined && zoned === undefined) {
      header.writeUInt16BE(0x8180 | zone.miss, 2);
      header.writeUInt16BE(0, 6);
      return Buffer.concat([header, question]);
    }
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(1, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(30, 6);
    rr.writeUInt16BE(4, 10);
    const ip = zoned ?? (behaviour === "wrong-ip" ? "100.127.255.1" : BOAT_AGENT_GATEWAY_ADDRESS);
    Buffer.from(ip.split(".").map(Number)).copy(rr, 12);
    return Buffer.concat([header, question, rr]);
  };
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
  const port = address.port;
  await new Promise<void>((resolve) => udp.bind(port, "127.0.0.1", resolve));
  udp.on("message", (message, remote) => {
    const reply = answer(message);
    if (reply !== null) udp.send(reply, remote.port, remote.address);
  });
  return {
    port,
    asked,
    close: async () => {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    },
  };
};

/** A loopback port free for both TCP and UDP right now. */
const freePort = async (): Promise<number> => {
  for (;;) {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (typeof address !== "object" || address === null) continue;
    const udp = dgram.createSocket("udp4");
    const free = await new Promise<boolean>((resolve) => {
      udp.once("error", () => resolve(false));
      udp.bind(address.port, "127.0.0.1", () => resolve(true));
    });
    udp.close();
    if (free) return address.port;
  }
};

/** Ask `name` (type A) of a resolver over UDP or TCP: its rcode and the first address it gave. */
const lookup = async (
  port: number,
  name: string,
  transport: "udp" | "tcp",
): Promise<{ readonly rcode: number; readonly address: string | null }> => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x5a5a, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const query = Buffer.concat([
    header,
    ...name
      .split(".")
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer for ${name} over ${transport}`)),
      5_000,
    );
    const settle = (message: Buffer) => {
      clearTimeout(timer);
      resolve(message);
    };
    if (transport === "udp") {
      const socket = dgram.createSocket("udp4");
      socket.on("message", (message) => {
        socket.close();
        settle(message);
      });
      socket.send(query, port, "127.0.0.1");
    } else {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(query.length, 0);
        socket.write(Buffer.concat([prefix, query]));
      });
      let pending = Buffer.alloc(0);
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
          socket.destroy();
          settle(pending.subarray(2, 2 + pending.readUInt16BE(0)));
        }
      });
    }
  });
  expect(reply.readUInt16BE(0)).toBe(0x5a5a);
  const rcode = reply.readUInt16BE(2) & 0x000f;
  return {
    rcode,
    address:
      reply.readUInt16BE(6) > 0 ? Array.from(reply.subarray(reply.length - 4)).join(".") : null,
  };
};

/** A UDP port free on loopback right now. */
const freeUdpPort = async (): Promise<number> => {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
};

/** Core's end of the carrier, as a test drives it: datagrams in, datagrams out. */
const openCarrier = async (agent: Agent, bearer: string) => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(agent.port)}${BOAT_AGENT_TUNNEL_ROUTE}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const received: Buffer[] = [];
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  socket.on("message", (data: Buffer) => received.push(Buffer.from(data)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`carrier refused: ${String(response.statusCode)}`)),
    );
    socket.once("error", reject);
  });
  return { socket, received, closed };
};

describe("boat agent · network", () => {
  it("validates the config the way the Python guest did", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    const refusal = async (body: unknown) => {
      const result = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer });
      expect(result.status).toBe(400);
      return boatAgentRefusalSchema.parse(result.body).reason;
    };
    expect(
      (await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body: networkBody(), bearer: "no" }))
        .status,
    ).toBe(401);
    const { subnet: _dropped, ...missing } = networkBody();
    expect(await refusal(missing)).toBe("invalid-network-config");
    expect(await refusal(networkBody({ extra: 1 }))).toBe("invalid-network-config");
    expect(await refusal(networkBody({ format: "sealant-guest-network-v2" }))).toBe(
      "invalid-network-config",
    );
    expect(await refusal(networkBody({ private_key: "short" }))).toBe("invalid-network-key");
    expect(await refusal(networkBody({ gateway_key: `${"A".repeat(43)}=` }))).toBe(
      "invalid-network-key",
    );
    expect(await refusal(networkBody({ public_key: `${"A".repeat(42)}B=` }))).toBe(
      "invalid-network-key",
    );
    expect(await refusal(networkBody({ subnet: "10.42.7.0/24" }))).toBe(
      "invalid-network-destination",
    );
    expect(await refusal(networkBody({ subnet: "10.42.7.33/27" }))).toBe(
      "invalid-network-destination",
    );
    expect(await refusal(networkBody({ subnet: "8.8.8.0/27" }))).toBe(
      "invalid-network-destination",
    );
    expect(await refusal(networkBody({ endpoint: "127.0.0.1" }))).toBe(
      "invalid-network-destination",
    );
    expect(await refusal(networkBody({ endpoint: "gateway.example" }))).toBe(
      "invalid-network-destination",
    );
    expect(await refusal(networkBody({ port: 0 }))).toBe("invalid-network-destination");
    expect(await refusal(networkBody({ port: "51820" }))).toBe("invalid-network-destination");
    expect(await netLines(vm)).toEqual([]);
    expect(await exists(path.join(vm.dataDir, "network.json"))).toBe(false);
  });

  it("brings up sealant-wg with the key in a tmpfs file wg alone reads, points DNS at the gateway, and replays without mutating", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    const body = networkBody();
    const privateKey = z.string().parse(body["private_key"]);
    const gatewayKey = z.string().parse(body["gateway_key"]);

    const configured = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer });
    expect(configured.status).toBe(200);
    const status = boatAgentNetworkResponseSchema.parse(configured.body);
    const recordBytes = await readFile(path.join(vm.dataDir, "network.json"));
    expect(status).toEqual({
      format: "sealant-guest-network-status-v1",
      binding: body["binding"],
      receipt: sha256(recordBytes),
      configured: true,
      handshake: "unverified",
    });
    const lines = await netLines(vm);
    const wg = BOAT_AGENT_WIREGUARD_INTERFACE;
    // The key file lives on the agent's tmpfs state directory only while wg runs.
    const keyFile = path.join(vm.stateDir, "agent", `${wg}.key`);
    expect(lines).toEqual([
      `ip link add ${wg} type wireguard`,
      `wg set ${wg} private-key ${keyFile} peer ${gatewayKey} endpoint 203.0.113.10:51820 allowed-ips 10.42.7.32/27,${BOAT_AGENT_GATEWAY_ADDRESS}/32 persistent-keepalive 25`,
      `ip address add ${BOAT_AGENT_CLIENT_ADDRESS}/32 dev ${wg}`,
      `ip link set ${wg} mtu 1380`,
      `ip link set ${wg} up`,
      `ip route add 10.42.7.32/27 dev ${wg}`,
      `ip route add ${BOAT_AGENT_GATEWAY_ADDRESS}/32 dev ${wg}`,
    ]);
    expect(await readFile(`${vm.netLog}.wg-key`, "utf8")).toBe(`${privateKey}\n`);
    expect(await exists(keyFile)).toBe(false);
    // The private key reached wg's file and nowhere else: not in any argv, record or console line.
    expect(lines.join("\n")).not.toContain(privateKey);
    expect(recordBytes.toString("utf8")).not.toContain(privateKey);
    expect(agent.output()).not.toContain(privateKey);

    expect((await lstat(vm.resolvConf)).isSymbolicLink()).toBe(false);
    // The VM resolves through its own resolver on the tunnel's address, never the gateway alone.
    expect(await readFile(vm.resolvConf, "utf8")).toBe(
      `nameserver ${BOAT_AGENT_CLIENT_ADDRESS}\noptions timeout:3 attempts:2\n`,
    );
    expect((await stat(vm.resolvConf)).mode & 0o777).toBe(0o644);
    const original = JSON.parse(await readFile(path.join(vm.dataDir, "resolv.conf.orig"), "utf8"));
    expect(original).toEqual({
      symlink: path.join(vm.dir, "etc", "stub-resolv.conf"),
      contentBase64: Buffer.from("nameserver 127.0.0.53\n").toString("base64"),
    });

    // The same config again: verified, nothing issued, same receipt.
    const replay = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer });
    expect(replay).toEqual(configured);
    expect((await netLines(vm)).length).toBeGreaterThanOrEqual(lines.length);
    expect((await netLines(vm)).slice(0, lines.length)).toEqual(lines);
    expect((await netLines(vm)).slice(lines.length).some((line) => line.startsWith("wg set"))).toBe(
      false,
    );
    expect(
      (await netLines(vm))
        .slice(lines.length)
        .some((line) => /^ip (link add|route add|address add)/.test(line)),
    ).toBe(false);
    expect(await readFile(path.join(vm.dataDir, "resolv.conf.orig"), "utf8")).toBe(
      JSON.stringify(original),
    );

    // A different config on the same boot is a conflict.
    const conflict = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
      body: networkBody({ gateway_key: gatewayKey, port: 51821 }),
      bearer,
    });
    expect(conflict.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(conflict.body)).toEqual({
      reason: "network-binding-conflict",
    });

    // A fresh agent on the same boot still knows the network and replays it.
    await stopAgent(agent);
    const restarted = await startAgent(vm);
    expect(await call(restarted, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).toEqual(
      configured,
    );
  });

  it("puts the VM's own resolver back at start on a boot without the tunnel, and keeps the gateway's on the boot that has it", async () => {
    // The stock image: resolv.conf is systemd-resolved's stub symlink.
    const vm = await createVm();
    const stub = path.join(vm.dir, "etc", "stub-resolv.conf");
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm);
    const body = networkBody();
    expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
      200,
    );
    expect(await readFile(vm.resolvConf, "utf8")).toContain(BOAT_AGENT_CLIENT_ADDRESS);
    // The same boot again (an agent restart): the tunnel is still there, so is its resolver.
    await stopAgent(agent);
    const sameBoot = await startAgent(vm);
    expect((await lstat(vm.resolvConf)).isSymbolicLink()).toBe(false);
    expect(await readFile(vm.resolvConf, "utf8")).toContain(BOAT_AGENT_CLIENT_ADDRESS);
    expect(await exists(path.join(vm.dataDir, "resolv.conf.orig"))).toBe(true);
    // Rebooted (or restored from a saved snapshot): no tunnel on this boot, the stub is back
    // exactly as it was (the symlink, not a copy of its bytes), and the kept copy is gone.
    await stopAgent(sameBoot);
    await vm.reboot();
    const rebooted = await startAgent(vm);
    expect((await lstat(vm.resolvConf)).isSymbolicLink()).toBe(true);
    expect(await readlink(vm.resolvConf)).toBe(stub);
    expect(await readFile(vm.resolvConf, "utf8")).toBe("nameserver 127.0.0.53\n");
    expect(await exists(path.join(vm.dataDir, "resolv.conf.orig"))).toBe(false);
    expect(rebooted.output()).toContain("the VM's own resolver is back");
    // A new bind and network on this boot keep the stub afresh and replace it again.
    const rebound = await bindVm(vm, "op-2");
    expect(
      (await call(rebooted, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer: rebound })).status,
    ).toBe(200);
    expect(JSON.parse(await readFile(path.join(vm.dataDir, "resolv.conf.orig"), "utf8"))).toEqual({
      symlink: stub,
      contentBase64: Buffer.from("nameserver 127.0.0.53\n").toString("base64"),
    });

    // An image whose resolv.conf is a plain file gets its bytes back.
    const plain = await createVm();
    await rm(plain.resolvConf);
    await writeFile(plain.resolvConf, "nameserver 10.0.0.2\nsearch corp.example\n");
    const plainBearer = await bindVm(plain);
    const plainAgent = await startAgent(plain);
    expect(
      (await call(plainAgent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer: plainBearer }))
        .status,
    ).toBe(200);
    await stopAgent(plainAgent);
    await plain.reboot();
    await startAgent(plain);
    expect((await lstat(plain.resolvConf)).isSymbolicLink()).toBe(false);
    expect(await readFile(plain.resolvConf, "utf8")).toBe(
      "nameserver 10.0.0.2\nsearch corp.example\n",
    );
    expect(await exists(path.join(plain.dataDir, "resolv.conf.orig"))).toBe(false);
  });

  it("carries the tunnel over /sealant/tunnel: WireGuard's datagrams to Core and back, nothing else", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const wireguardPort = await freeUdpPort();
    const env = { SEALANT_AGENT_TUNNEL_WG_PORT: String(wireguardPort) };
    const agent = await startAgent(vm, env);
    // Before any config: the agent says it can carry the tunnel, and has nothing to carry yet.
    const before = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
    expect(boatAgentNetworkStatusSchema.parse(before.body).carriers).toEqual(["udp", "websocket"]);
    await expect(openCarrier(agent, bearer)).rejects.toThrow("carrier refused: 409");
    // The carried config names no endpoint, and an endpoint beside the carrier is refused.
    const body: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(networkBody()).filter(([key]) => key !== "endpoint" && key !== "port"),
      ),
      carrier: "websocket",
    };
    const mixed = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
      body: { ...body, endpoint: "203.0.113.10" },
      bearer,
    });
    expect(mixed).toEqual({ status: 400, body: { reason: "invalid-network-config" } });
    expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
      200,
    );
    const gatewayKey = z.string().parse(body["gateway_key"]);
    const set = (await netLines(vm)).find((line) => line.startsWith("wg set "));
    const relayPort = Number(/endpoint 127\.0\.0\.1:(\d+) /.exec(set ?? "")?.[1] ?? Number.NaN);
    expect(set).toMatch(
      new RegExp(
        `^wg set ${BOAT_AGENT_WIREGUARD_INTERFACE} listen-port ${String(wireguardPort)} private-key \\S+ peer ${gatewayKey.replace(/[+/]/g, "\\$&")} endpoint 127\\.0\\.0\\.1:\\d+ allowed-ips`,
      ),
    );
    expect(Number.isInteger(relayPort)).toBe(true);

    // WireGuard, as the relay sees it: datagrams from its own port.
    const wireguard = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => wireguard.bind(wireguardPort, "127.0.0.1", resolve));
    const toWireguard: Buffer[] = [];
    wireguard.on("message", (message) => toWireguard.push(message));
    try {
      expect(
        boatAgentNetworkStatusSchema.parse(
          (await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer })).body,
        ).carrier_attached,
      ).toBe(false);
      await expect(openCarrier(agent, "f".repeat(64))).rejects.toThrow("carrier refused: 401");
      const core = await openCarrier(agent, bearer);
      expect(
        boatAgentNetworkStatusSchema.parse(
          (await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer })).body,
        ).carrier_attached,
      ).toBe(true);
      // Out: a handshake initiation from WireGuard reaches Core as one binary frame.
      wireguard.send(Buffer.from("initiation"), relayPort, "127.0.0.1");
      await waitFor(async () => core.received.length === 1);
      expect(core.received[0]?.toString()).toBe("initiation");
      // In: Core's frame reaches WireGuard's own port.
      core.socket.send(Buffer.from("response"));
      await waitFor(async () => toWireguard.length === 1);
      expect(toWireguard[0]?.toString()).toBe("response");
      // Anything else on the VM sending to the relay is not WireGuard, and goes nowhere.
      const stranger = dgram.createSocket("udp4");
      await new Promise<void>((resolve) => stranger.bind(0, "127.0.0.1", resolve));
      stranger.send(Buffer.from("not-wireguard"), relayPort, "127.0.0.1");
      await new Promise((resolve) => setTimeout(resolve, 200));
      stranger.close();
      expect(core.received.map(String)).toEqual(["initiation"]);
      // A newer carrier takes over; the older is closed with 1012 (restart).
      const newer = await openCarrier(agent, bearer);
      expect(await core.closed).toBe(1012);
      wireguard.send(Buffer.from("keepalive"), relayPort, "127.0.0.1");
      await waitFor(async () => newer.received.length === 1);
      expect(newer.received[0]?.toString()).toBe("keepalive");

      // An agent restarted on the same boot binds the relay where WireGuard's peer still points.
      newer.socket.close();
      await stopAgent(agent);
      const restarted = await startAgent(vm, env);
      const after = await openCarrier(restarted, bearer);
      wireguard.send(Buffer.from("after-restart"), relayPort, "127.0.0.1");
      await waitFor(async () => after.received.length === 1);
      expect(after.received[0]?.toString()).toBe("after-restart");
      expect((await netLines(vm)).filter((line) => line.startsWith("wg set "))).toHaveLength(1);
      after.socket.close();
    } finally {
      wireguard.close();
    }
  });

  it("relays to the port WireGuard picked itself, read back once its interface is up", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const wireguardPort = await freeUdpPort();
    // As the kernel would answer `wg show sealant-wg listen-port` after `ip link set up`.
    await writeFile(path.join(vm.dir, "wg-handshake.listen-port"), `${String(wireguardPort)}\n`);
    const agent = await startAgent(vm);
    const body: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(networkBody()).filter(([key]) => key !== "endpoint" && key !== "port"),
      ),
      carrier: "websocket",
    };
    expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
      200,
    );
    const lines = await netLines(vm);
    const set = lines.find((line) => line.startsWith("wg set ")) ?? "";
    // No port is handed to WireGuard: one picked here could be taken before it binds.
    expect(set).not.toContain("listen-port");
    expect(lines.indexOf(`wg show ${BOAT_AGENT_WIREGUARD_INTERFACE} listen-port`)).toBeGreaterThan(
      lines.indexOf(`ip link set ${BOAT_AGENT_WIREGUARD_INTERFACE} up`),
    );
    const relayPort = Number(/endpoint 127\.0\.0\.1:(\d+) /.exec(set)?.[1]);
    const wireguard = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => wireguard.bind(wireguardPort, "127.0.0.1", resolve));
    try {
      const core = await openCarrier(agent, bearer);
      wireguard.send(Buffer.from("initiation"), relayPort, "127.0.0.1");
      await waitFor(async () => core.received.length === 1);
      expect(core.received[0]?.toString()).toBe("initiation");
      // A message split into fragments on the way (a proxy may re-frame it) is one datagram.
      const toWireguard: Buffer[] = [];
      wireguard.on("message", (message) => toWireguard.push(message));
      core.socket.send(Buffer.from("frag"), { binary: true, fin: false });
      core.socket.ping();
      core.socket.send(Buffer.from("mented"), { binary: true, fin: true });
      await waitFor(async () => toWireguard.length === 1);
      expect(toWireguard[0]?.toString()).toBe("fragmented");
      core.socket.close();
    } finally {
      wireguard.close();
    }
  });

  it("connects WireGuard to the gateway end to end through the agent's carrier and Core's", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const wireguardPort = await freeUdpPort();
    const agent = await startAgent(vm, { SEALANT_AGENT_TUNNEL_WG_PORT: String(wireguardPort) });
    const body: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(networkBody()).filter(([key]) => key !== "endpoint" && key !== "port"),
      ),
      carrier: "websocket",
    };
    expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
      200,
    );
    const relayPort = Number(
      /endpoint 127\.0\.0\.1:(\d+) /.exec(
        (await netLines(vm)).find((line) => line.startsWith("wg set ")) ?? "",
      )?.[1],
    );
    // The gateway's published port on Core's host, and the VM's WireGuard.
    const gateway = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => gateway.bind(0, "127.0.0.1", resolve));
    const atGateway: { data: Buffer; port: number }[] = [];
    gateway.on("message", (data, remote) => atGateway.push({ data, port: remote.port }));
    const wireguard = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => wireguard.bind(wireguardPort, "127.0.0.1", resolve));
    const atWireguard: Buffer[] = [];
    wireguard.on("message", (data) => atWireguard.push(data));
    const runtime = ManagedRuntime.make(
      makeBoatTunnelCarrierLayer({ reconnectMinMs: 20, reconnectMaxMs: 40 }),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(BoatTunnelCarrier, (carrier) =>
          carrier.ensure({
            runId: "run-e2e",
            connection: Effect.succeed(
              Redacted.make({
                url: `ws://127.0.0.1:${String(agent.port)}${BOAT_AGENT_TUNNEL_ROUTE}`,
                headers: { Authorization: `Bearer ${bearer}` },
              }),
            ),
            gateway: { host: "127.0.0.1", port: gateway.address().port },
          }),
        ),
      );
      await waitFor(async () =>
        Boolean(
          boatAgentNetworkStatusSchema.parse(
            (await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer })).body,
          ).carrier_attached,
        ),
      );
      // The VM's initiation reaches the gateway; the gateway's response reaches the VM.
      wireguard.send(Buffer.from("initiation"), relayPort, "127.0.0.1");
      await waitFor(async () => atGateway.length === 1);
      expect(atGateway[0]?.data.toString()).toBe("initiation");
      gateway.send(Buffer.from("response"), atGateway[0]?.port ?? 0, "127.0.0.1");
      await waitFor(async () => atWireguard.length === 1);
      expect(atWireguard[0]?.toString()).toBe("response");
    } finally {
      await runtime.dispose();
      wireguard.close();
      gateway.close();
    }
  });

  it("resolves resource names through the gateway and every other name through the VM's own resolver", async () => {
    // The gateway answers its reach network's names and nothing else (no upstream: SERVFAIL); the
    // VM's own resolver answers public names. On the gateway alone a public name never resolved
    // (VM 131, run 3: `capture plan.get failed: ... failed to lookup address information`).
    const gateway = await startFakeDns("answer", {
      names: { db: "10.42.7.40", "*.sealant.gateway.invalid": BOAT_AGENT_GATEWAY_ADDRESS },
      miss: 2,
    });
    const own = await startFakeDns("answer", {
      names: { "mend-boat-preview.tailnet.example": "185.40.234.37" },
      miss: 3,
    });
    try {
      const vm = await createVm();
      // The VM's own resolver, as its stock resolv.conf names it.
      await writeFile(path.join(vm.dir, "etc", "stub-resolv.conf"), "nameserver 127.0.0.1\n");
      const bearer = await bindVm(vm);
      const listen = await freePort();
      const env = {
        SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
        SEALANT_AGENT_DNS_PROBE_PORT: String(gateway.port),
        SEALANT_AGENT_DNS_LISTEN_PORT: String(listen),
        SEALANT_AGENT_DNS_UPSTREAM_PORT: String(own.port),
      };
      const agent = await startAgent(vm, env);
      const body = networkBody();
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      expect(await readFile(vm.resolvConf, "utf8")).toBe(
        `nameserver ${BOAT_AGENT_CLIENT_ADDRESS}\noptions timeout:3 attempts:2\n`,
      );
      for (const transport of ["udp", "tcp"] as const) {
        // A resource name: the gateway's answer, and the VM's own resolver is never asked it.
        expect(await lookup(listen, "db", transport)).toEqual({ rcode: 0, address: "10.42.7.40" });
        // A public name: the gateway does not know it, the VM's own resolver does.
        expect(await lookup(listen, "mend-boat-preview.tailnet.example", transport)).toEqual({
          rcode: 0,
          address: "185.40.234.37",
        });
        // A name nobody knows: the VM's own resolver's NXDOMAIN, never the gateway's SERVFAIL.
        expect(await lookup(listen, "absent.example", transport)).toEqual({
          rcode: 3,
          address: null,
        });
      }
      expect(own.asked).not.toContain("db");
      expect(own.asked).toContain("mend-boat-preview.tailnet.example");
      // Readiness asks the VM's resolver, the way the VM asks: it reaches the gateway.
      await vm.setHandshake(`${z.string().parse(body["gateway_key"])}\t1760000000`);
      const status = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(boatAgentNetworkStatusSchema.parse(status.body)).toMatchObject({ dns: "udp-and-tcp" });
      // An agent restarted on the same boot answers again on the same address.
      await stopAgent(agent);
      await startAgent(vm, env);
      expect(await lookup(listen, "mend-boat-preview.tailnet.example", "udp")).toEqual({
        rcode: 0,
        address: "185.40.234.37",
      });
    } finally {
      await gateway.close();
      await own.close();
    }
  });

  it("reports what the tunnel sent and received, so a handshake that never comes says which side is silent", async () => {
    const dns = await startFakeDns();
    try {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const body = networkBody();
      const gatewayKey = z.string().parse(body["gateway_key"]);
      const agent = await startAgent(vm, {
        SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
        SEALANT_AGENT_DNS_PROBE_PORT: String(dns.port),
      });
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      // VM 131: initiations went out, nothing came back. Another peer's line is not the gateway's.
      await vm.setHandshake(`${gatewayKey}\t0`);
      await vm.setTransfer(`${"o".repeat(43)}=\t9\t9\n${gatewayKey}\t0\t444`);
      const silent = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(boatAgentNetworkStatusSchema.parse(silent.body)).toMatchObject({
        handshake: "unverified",
        transfer: { sent: 444, received: 0 },
      });
      // No counters to read (wg fails): the field is absent, never a guess.
      await rm(path.join(vm.dir, "wg-handshake.transfer"), { force: true });
      await writeFile(`${vm.netLog}.fail-wg`, "");
      const unread = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(boatAgentNetworkStatusSchema.parse(unread.body)).not.toHaveProperty("transfer");
    } finally {
      await dns.close();
    }
  });

  it("verifies the handshake without DNS: a resolver that does not answer is `dns`, never `handshake`", async () => {
    const silent = await startFakeDns("silent");
    try {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const body = networkBody();
      const gatewayKey = z.string().parse(body["gateway_key"]);
      await vm.setHandshake(`${gatewayKey}\t1760000000`);
      await vm.setTransfer(`${gatewayKey}\t148\t296`);
      const agent = await startAgent(vm, {
        SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
        SEALANT_AGENT_DNS_PROBE_PORT: String(silent.port),
      });
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      const status = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(boatAgentNetworkStatusSchema.parse(status.body)).toEqual({
        configured: true,
        handshake: "verified",
        dns: "unavailable",
        docker_policy: "absent",
        transfer: { sent: 296, received: 148 },
        carriers: ["udp", "websocket"],
      });
    } finally {
      await silent.close();
    }
  });

  it("fails the network step when the VM's resolver cannot bind, and leaves resolv.conf the VM's", async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    // Something else holds the resolver's address and port.
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    try {
      const agent = await startAgent(vm, { SEALANT_AGENT_DNS_LISTEN_PORT: String(address.port) });
      const configured = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
        body: networkBody(),
        bearer,
      });
      expect(configured.status).toBe(500);
      // Named by the step it failed in, like every network setup failure.
      expect(configured.body).toEqual({ reason: "network-resolver-failed" });
      expect((await lstat(vm.resolvConf)).isSymbolicLink()).toBe(true);
      expect(await readFile(vm.resolvConf, "utf8")).toBe("nameserver 127.0.0.53\n");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("reports the handshake and the gateway's DNS over UDP and TCP", async () => {
    const dns = await startFakeDns();
    try {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const body = networkBody();
      const gatewayKey = z.string().parse(body["gateway_key"]);
      await vm.setHandshake(`${gatewayKey}\t1760000000`);
      const agent = await startAgent(vm, {
        SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
        SEALANT_AGENT_DNS_PROBE_PORT: String(dns.port),
      });
      expect((await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer: "no" })).status).toBe(
        401,
      );
      const before = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(before.status).toBe(200);
      expect(boatAgentNetworkStatusSchema.parse(before.body)).toEqual({
        configured: false,
        handshake: "unverified",
        dns: "unavailable",
        docker_policy: "absent",
        carriers: ["udp", "websocket"],
      });
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      const verified = await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
      expect(boatAgentNetworkStatusSchema.parse(verified.body)).toEqual({
        configured: true,
        handshake: "verified",
        dns: "udp-and-tcp",
        docker_policy: "absent",
        carriers: ["udp", "websocket"],
      });
      expect(
        (await netLines(vm)).filter(
          (line) => line === `wg show ${BOAT_AGENT_WIREGUARD_INTERFACE} latest-handshakes`,
        ),
      ).toHaveLength(1);

      // No handshake yet, and a resolver that answers with the wrong address: neither is verified.
      await stopAgent(agent);
      await dns.close();
      const wrong = await startFakeDns("wrong-ip");
      try {
        await vm.setHandshake(`${gatewayKey}\t0`);
        const unverified = await startAgent(vm, {
          SEALANT_AGENT_DNS_PROBE_HOST: "127.0.0.1",
          SEALANT_AGENT_DNS_PROBE_PORT: String(wrong.port),
        });
        const result = await call(unverified, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer });
        expect(boatAgentNetworkStatusSchema.parse(result.body)).toEqual({
          configured: true,
          handshake: "unverified",
          dns: "unavailable",
          docker_policy: "absent",
          carriers: ["udp", "websocket"],
        });
      } finally {
        await wrong.close();
      }
    } finally {
      await dns.close().catch(() => {});
    }
  });

  const dockerLaunched = async (vm: Vm, extraEnv: Record<string, string> = {}) => {
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm, {
      SEALANT_MICROVM_DOCKER_CAPABLE: "1",
      SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      ...extraEnv,
    });
    const accepted = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
      body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
      bearer,
    });
    expect(accepted).toMatchObject({ status: 200, body: { outcome: "booting" } });
    await waitFor(
      async () => (await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).status === 200,
      10_000,
    );
    return { agent, bearer };
  };
  const policyStatus = async (agent: Agent, bearer: string) =>
    boatAgentNetworkStatusSchema.parse(
      (await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer })).body,
    ).docker_policy;

  it(
    "holds containers to the gateway's allowance, atomically per family, once dockerd and the network are up",
    { timeout: 20_000 },
    async () => {
      const vm = await createVm();
      const { agent, bearer } = await dockerLaunched(vm);
      expect(await policyStatus(agent, bearer)).toBe("pending");
      expect((await netLines(vm)).some((line) => line.includes("tables"))).toBe(false);

      expect(
        (await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body: networkBody(), bearer }))
          .status,
      ).toBe(200);
      await waitFor(async () => (await policyStatus(agent, bearer)) === "applied");
      const denied = [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
      ];
      const endpoint = z.string().parse(networkBody()["endpoint"]);
      expect(await readFile(`${vm.netLog}.iptables-restore-stdin`, "utf8")).toBe(
        [
          "*filter",
          ":DOCKER-USER - [0:0]",
          ":SEALANT-DOCKER-INPUT - [0:0]",
          "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
          // Docker's own networks only, not all of 198.18.0.0/15.
          "-A DOCKER-USER -d 198.18.1.0/24 -j RETURN",
          "-A DOCKER-USER -d 198.19.0.0/16 -j RETURN",
          `-A DOCKER-USER -o ${BOAT_AGENT_WIREGUARD_INTERFACE} -d 10.42.7.32/27 -j RETURN`,
          `-A DOCKER-USER -o ${BOAT_AGENT_WIREGUARD_INTERFACE} -d ${BOAT_AGENT_GATEWAY_ADDRESS}/32 -p udp --dport 53 -j RETURN`,
          `-A DOCKER-USER -o ${BOAT_AGENT_WIREGUARD_INTERFACE} -d ${BOAT_AGENT_GATEWAY_ADDRESS}/32 -p tcp --dport 53 -j RETURN`,
          `-A DOCKER-USER -d ${endpoint}/32 -j DROP`,
          ...denied.map((cidr) => `-A DOCKER-USER -d ${cidr} -j DROP`),
          "-A DOCKER-USER -j RETURN",
          // No new connection from a container to the VM itself but DNS to the VM's resolver.
          `-A SEALANT-DOCKER-INPUT -d ${BOAT_AGENT_CLIENT_ADDRESS}/32 -p udp --dport 53 -j RETURN`,
          `-A SEALANT-DOCKER-INPUT -d ${BOAT_AGENT_CLIENT_ADDRESS}/32 -p tcp --dport 53 -j RETURN`,
          // Matched by what a container is, whatever its bridge is called or its subnet is.
          "-A SEALANT-DOCKER-INPUT -s 198.18.1.0/24 -m conntrack --ctstate NEW -j DROP",
          "-A SEALANT-DOCKER-INPUT -s 198.19.0.0/16 -m conntrack --ctstate NEW -j DROP",
          "-A SEALANT-DOCKER-INPUT -m physdev --physdev-is-in -m conntrack --ctstate NEW -j DROP",
          "COMMIT",
          "",
        ].join("\n"),
      );
      // IPv6: nothing forwarded for a container, nothing new from a bridge to the VM.
      expect(await readFile(`${vm.netLog}.ip6tables-restore-stdin`, "utf8")).toBe(
        [
          "*filter",
          ":DOCKER-USER - [0:0]",
          ":SEALANT-DOCKER-INPUT - [0:0]",
          "-A DOCKER-USER -j DROP",
          "-A SEALANT-DOCKER-INPUT -m physdev --physdev-is-in -m conntrack --ctstate NEW -j DROP",
          "COMMIT",
          "",
        ].join("\n"),
      );
      const lines = await netLines(vm);
      expect(lines).toContain("iptables-restore --noflush");
      expect(lines).toContain("ip6tables-restore --noflush");
      // The chains are reached: checked, and inserted only when missing.
      expect(lines).toContain("iptables -C INPUT -j SEALANT-DOCKER-INPUT");
      expect(lines).toContain("ip6tables -C INPUT -j SEALANT-DOCKER-INPUT");
      expect(lines).toContain("ip6tables -C FORWARD -j DOCKER-USER");
      // Nothing is applied rule by rule any more.
      expect(lines.some((line) => line.startsWith("iptables -A"))).toBe(false);
    },
  );

  it(
    "keeps an applied policy applied while Core's replay of the same network re-applies it",
    { timeout: 20_000 },
    async () => {
      const vm = await createVm();
      const { agent, bearer } = await dockerLaunched(vm);
      const body = networkBody();
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      await waitFor(async () => (await policyStatus(agent, bearer)) === "applied");
      // Core replays the same config right before it reads the state; the re-apply is in flight
      // (held longer than the read, DNS probe included) when the read lands. The chains never lapse, so: applied.
      await writeFile(`${vm.netLog}.slow-iptables-restore`, "");
      expect((await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body, bearer })).status).toBe(
        200,
      );
      expect(await policyStatus(agent, bearer)).toBe("applied");
    },
  );

  it(
    "reports a policy that did not apply, so readiness refuses instead of failing open",
    { timeout: 20_000 },
    async () => {
      const vm = await createVm();
      await writeFile(`${vm.netLog}.fail-ip6tables-restore`, "");
      const { agent, bearer } = await dockerLaunched(vm);
      await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body: networkBody(), bearer });
      await waitFor(async () => (await policyStatus(agent, bearer)) === "failed");
    },
  );

  it("reports no policy for an image without Docker", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    expect(await policyStatus(agent, bearer)).toBe("absent");
  });
});

/** A raw WebSocket upgrade request, so a refusal's status, body and content type are readable. */
const upgrade = (
  agent: Agent,
  bearer: string,
): Promise<{ readonly status: number; readonly body: string; readonly type: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: agent.port,
      path: AGENT_CONTROL_ROUTE,
      headers: {
        authorization: `Bearer ${bearer}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: 101, body: "", type: "" });
    });
    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          type: String(response.headers["content-type"] ?? ""),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });

describe("boat agent · control relay", () => {
  it("answers 503 {error: control-unavailable} until the daemon's socket accepts", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    // No socket at all.
    const missing = await upgrade(agent, bearer);
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.body)).toEqual({ error: "control-unavailable" });
    expect(missing.type).toContain("application/json");
    // A path that is there but accepts no connection: the connect comes first, so no 101 is sent.
    await writeFile(vm.socketPath, "");
    const refused = await upgrade(agent, bearer);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "control-unavailable" });
    await rm(vm.socketPath);
    expect((await upgrade(agent, "nope")).status).toBe(401);
  });

  it("relays once the socket accepts", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    expect((await upgrade(agent, bearer)).status).toBe(101);
  });
});

/**
 * The host's `sleep` executable and the arguments that make a copy of it sleep 300 s under
 * another name: a multi-call coreutils (NixOS) needs to be told which program it is.
 */
const realSleep = async (): Promise<{
  readonly path: string;
  readonly args: readonly string[];
}> => {
  const found = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  const resolved = await realpath(found);
  return {
    path: resolved,
    args: path.basename(resolved) === "coreutils" ? ["--coreutils-prog=sleep", "300"] : ["300"],
  };
};

/** Shims the tests started; killed at the end whatever the test did. */
const shims = new Set<number>();
afterEach(() => {
  for (const pid of shims) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
  shims.clear();
});

const parkReceipt = async (vm: Vm, operationId: string) =>
  boatAgentParkReceiptSchema.parse(
    JSON.parse(await readFile(path.join(vm.dataDir, `park-${operationId}.json`), "utf8")),
  );

describe("boat agent · park proves Docker gone, on Boat's defaults", () => {
  /**
   * A Docker VM whose agent runs on Boat's defaults: nothing about the stop is injected, only
   * where the cgroup filesystem is mounted (a scratch directory here, as the test is not root).
   */
  const dockerVm = async (prepare?: (cgroupRoot: string) => Promise<void>) => {
    const vm = await createVm();
    const cgroupRoot = path.join(vm.dir, "cgroup");
    await prepare?.(cgroupRoot);
    const dockerLog = path.join(vm.dir, "docker-cli.log");
    const dockerdArgs = path.join(vm.dir, "dockerd-args");
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm, {
      SEALANT_MICROVM_DOCKER_CAPABLE: "1",
      SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_PS: "0123456789ab",
      FAKE_DOCKERD_ARGS: dockerdArgs,
    });
    const accepted = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
      body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
      bearer,
    });
    expect(accepted.status).toBe(200);
    await waitFor(
      async () => (await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).status === 200,
      10_000,
    );
    return { vm, agent, bearer, cgroupRoot, dockerLog, dockerdArgs };
  };
  const park = (agent: Agent, bearer: string, operationId: string) =>
    call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });

  it(
    "parks an ordinary Docker session: containers stopped with their grace, Docker's cgroups proved empty",
    { timeout: 30_000 },
    async () => {
      const { vm, agent, bearer, cgroupRoot, dockerLog, dockerdArgs } = await dockerVm();
      // dockerd joined the engine cgroup before it could start anything, under its own pid.
      const engineProcs = (
        await readFile(path.join(cgroupRoot, "sealant-docker-engine", "cgroup.procs"), "utf8")
      ).trim();
      expect(engineProcs).toMatch(/^\d+$/);
      expect(await readFile(dockerdArgs, "utf8")).toContain(
        "--cgroup-parent sealant-docker.slice --exec-opt native.cgroupdriver=systemd",
      );
      // dockerd uses the bundle's own containerd, never one it would find on the VM (run 7), and
      // was ready only after a real container ran.
      expect(await readFile(dockerdArgs, "utf8")).toMatch(
        /^--containerd \S+\/containerd\/containerd\.sock /,
      );
      expect(await readFile(dockerLog, "utf8")).toMatch(
        / run --rm --network none --pull never --log-driver none sealant-engine-probe:1 --version/,
      );
      // A second containerd outside Docker's cgroups, from the same engine path, is not Docker's.
      const sleep = await realSleep();
      const engineCopy = path.join(vm.bin, "containerd");
      await copyFile(sleep.path, engineCopy);
      await chmod(engineCopy, 0o755);
      const bystander = spawn(engineCopy, [...sleep.args], { detached: true, stdio: "ignore" });
      const bystanderPid = bystander.pid ?? 0;
      shims.add(bystanderPid);

      const operationId = randomUUID();
      const parked = await park(agent, bearer, operationId);
      expect(parked.status).toBe(200);
      expect((await parkReceipt(vm, operationId)).docker).toBe("stopped");
      expect(await readFile(dockerLog, "utf8")).toContain("stop --time 10 0123456789ab");
      expect(alive(bystanderPid)).toBe(true);
    },
  );

  it(
    "refuses while Docker's cgroups cannot be proved empty, asks them to die, and parks on a retry",
    { timeout: 30_000 },
    async () => {
      // Populated where systemd really puts the slice; nothing at the flat path a guess would use.
      const { vm, agent, bearer, cgroupRoot } = await dockerVm(async (root) => {
        const slice = path.join(root, "sealant.slice", "sealant-docker.slice");
        await mkdir(slice, { recursive: true });
        await writeFile(path.join(slice, "cgroup.events"), "populated 1\nfrozen 0\n");
      });
      expect(await exists(path.join(cgroupRoot, "sealant-docker.slice"))).toBe(false);
      const slice = path.join(cgroupRoot, "sealant.slice", "sealant-docker.slice");
      const operationId = randomUUID();
      expect(await park(agent, bearer, operationId)).toMatchObject({
        status: 503,
        body: { reason: "docker-stop-unverified" },
      });
      expect(await exists(path.join(vm.dataDir, `park-${operationId}.json`))).toBe(false);
      expect(await readFile(path.join(slice, "cgroup.kill"), "utf8")).toBe("1");
      // Still closed for recovery while the park is unfinished.
      expect(
        (await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer })).body,
      ).toEqual({ reason: "parked" });
      await writeFile(path.join(slice, "cgroup.events"), "populated 0\nfrozen 0\n");
      expect((await park(agent, bearer, operationId)).status).toBe(200);
      expect((await parkReceipt(vm, operationId)).docker).toBe("stopped");
    },
  );

  it("recovers an ordinary Docker session whose daemon exited", { timeout: 30_000 }, async () => {
    const vm = await createVm();
    const bearer = await bindVm(vm);
    const agent = await startAgent(vm, {
      SEALANT_MICROVM_DOCKER_CAPABLE: "1",
      SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      FAKE_SEALANTD_EXIT75: "1",
    });
    expect(
      (
        await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
          body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
          bearer,
        })
      ).status,
    ).toBe(200);
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75, 10_000);
    const recovered = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(recovered).toMatchObject({ status: 200, body: { outcome: "restarted" } });
    // The recovery boot names no Docker daemon: it was stopped and proved gone first (#516).
    await waitFor(async () => (await readDaemonRecord(vm)).argv.includes("--recovery"));
    const recovery = await readDaemonRecord(vm);
    expect(recovery.env).not.toHaveProperty("DOCKER_HOST");
    expect(recovery.env).not.toHaveProperty("SEALANT_WORKSPACE_DOCKER_HOST");
  });

  it(
    "never certifies a park while a launch is still writing its material",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm);
      const archives = Array.from({ length: 300 }, (_, index) => ({
        name: `a${String(index)}.tar`,
        contentBase64: randomBytes(64 * 1024).toString("base64"),
      }));
      const progress = { launchDone: false };
      const launch = call(agent, "POST", AGENT_LAUNCH_ROUTE, {
        body: launchBody(bearer, { dotfiles: { manifestJson: "{}", archives } }),
        bearer,
      }).finally(() => {
        progress.launchDone = true;
      });
      await waitFor(() => exists(path.join(vm.stateDir, "secrets", "env.json")), 10_000);
      const operationId = randomUUID();
      const during = new Set<string>();
      while (!progress.launchDone) {
        const attempt = await park(agent, bearer, operationId);
        during.add(`${String(attempt.status)} ${JSON.stringify(attempt.body)}`);
        if (attempt.status === 200) break;
      }
      const launchOutcome = await launch;
      // While the launch wrote its material, park only refused. A park that closed did so after
      // the launch was accepted, so it closed that launch: its daemon is gone, never left alive.
      for (const entry of during) {
        expect(
          entry.startsWith('409 {"reason":"launch-in-progress"}') || entry.startsWith("200 "),
        ).toBe(true);
      }
      expect([...during]).toContain('409 {"reason":"launch-in-progress"}');
      expect(launchOutcome).toMatchObject({ status: 200, body: { outcome: "booting" } });
      const closed = await park(agent, bearer, operationId);
      expect(closed.status).toBe(200);
      expect((await parkReceipt(vm, operationId)).daemon).toBe("stopped");
      // The launch's daemon is gone: health reports its exit (park may have killed it before
      // it wrote anything, so its own record is no witness).
      await waitFor(async () => {
        const health = await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer });
        return (
          typeof health.body === "object" &&
          health.body !== null &&
          "daemonExit" in health.body &&
          health.body.daemonExit !== undefined
        );
      });
    },
  );
});

describe("boat agent · recover never guesses nothing-to-save", () => {
  it(
    "answers recover-state-unknown, never nothing-to-save, while a launch is writing its material",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm);
      // Many fsynced dotfiles archives keep the claimed-but-unrecorded window wide.
      const archives = Array.from({ length: 300 }, (_, index) => ({
        name: `a${String(index)}.tar`,
        contentBase64: randomBytes(64 * 1024).toString("base64"),
      }));
      const progress = { launchDone: false };
      const launch = call(agent, "POST", AGENT_LAUNCH_ROUTE, {
        body: launchBody(bearer, { dotfiles: { manifestJson: "{}", archives } }),
        bearer,
      }).finally(() => {
        progress.launchDone = true;
      });
      await waitFor(() => exists(path.join(vm.stateDir, "secrets", "env.json")), 10_000);
      const outcomes = new Set<string>();
      while (!progress.launchDone) {
        const recover = await call(agent, "POST", AGENT_RECOVER_ROUTE, {
          body: recoverBody,
          bearer,
        });
        outcomes.add(`${String(recover.status)} ${JSON.stringify(recover.body)}`);
      }
      expect(await launch).toMatchObject({ status: 200, body: { outcome: "booting" } });
      expect([...outcomes].some((outcome) => outcome.includes("nothing-to-save"))).toBe(false);
      expect(outcomes.size).toBeGreaterThan(0);
    },
  );

  it("answers recover-state-unknown when the launch record is gone under a running daemon", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    await rm(path.join(vm.dataDir, "launch.json"));
    const recover = await call(agent, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer });
    expect(recover).toMatchObject({ status: 409, body: { reason: "recover-state-unknown" } });
  });
});

/** Send a body's first bytes now and the rest when told: the request is in flight meanwhile. */
const partialBody = async (agent: Agent, route: string, bearer: string, body: unknown) => {
  const bytes = JSON.stringify(body);
  const pending: { finish: () => void } = { finish: () => undefined };
  const reply = new Promise<{ readonly status: number | undefined; readonly body: unknown }>(
    (resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: agent.port,
          path: route,
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bytes),
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(data) }),
          );
        },
      );
      request.on("error", reject);
      request.write(bytes.slice(0, 10));
      pending.finish = () => request.end(bytes.slice(10));
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { finish: () => pending.finish(), reply };
};

describe("boat agent · round-3 closures", () => {
  it(
    "never takes a containers' slice it cannot see for an empty one",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm, {
        SEALANT_MICROVM_DOCKER_CAPABLE: "1",
        SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      });
      expect(
        (
          await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
            body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
            bearer,
          })
        ).status,
      ).toBe(200);
      await waitFor(
        async () => (await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).status === 200,
        10_000,
      );
      // The slice systemd made is gone from where it was resolved: unknown, not empty.
      await rm(path.join(vm.dir, "cgroup", "sealant.slice"), { recursive: true });
      const operationId = randomUUID();
      const parked = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
        body: { format: "sealant-agent-park-v1", operationId },
        bearer,
      });
      expect(parked).toMatchObject({ status: 503, body: { reason: "docker-stop-unverified" } });
      expect(await exists(path.join(vm.dataDir, `park-${operationId}.json`))).toBe(false);
    },
  );

  it(
    "turns bridge netfilter on before calling the policy applied, and fails it when it cannot",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bridge = path.join(vm.dir, "proc-sys", "net", "bridge");
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm, {
        SEALANT_MICROVM_DOCKER_CAPABLE: "1",
        SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      });
      await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
        body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
        bearer,
      });
      await waitFor(
        async () => (await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).status === 200,
        10_000,
      );
      await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, { body: networkBody(), bearer });
      const policy = async () =>
        boatAgentNetworkStatusSchema.parse(
          (await call(agent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer })).body,
        ).docker_policy;
      await waitFor(async () => (await policy()) === "applied");
      expect(await readFile(path.join(bridge, "bridge-nf-call-iptables"), "utf8")).toBe("1\n");
      expect(await readFile(path.join(bridge, "bridge-nf-call-ip6tables"), "utf8")).toBe("1\n");
      expect(await netLines(vm)).toContain("modprobe br_netfilter");

      // A kernel without bridge netfilter (no net/bridge): the policy is not applied.
      const other = await createVm();
      await rm(path.join(other.dir, "proc-sys", "net", "bridge"), { recursive: true });
      const otherBearer = await bindVm(other);
      const otherAgent = await startAgent(other, {
        SEALANT_MICROVM_DOCKER_CAPABLE: "1",
        SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      });
      await call(otherAgent, "POST", AGENT_LAUNCH_ROUTE, {
        body: launchBody(otherBearer, { version: 2, services: { docker: "required" } }),
        bearer: otherBearer,
      });
      await waitFor(
        async () =>
          (await call(otherAgent, "GET", AGENT_HEALTH_ROUTE, { bearer: otherBearer })).status ===
          200,
        10_000,
      );
      await call(otherAgent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
        body: networkBody(),
        bearer: otherBearer,
      });
      await waitFor(
        async () =>
          boatAgentNetworkStatusSchema.parse(
            (await call(otherAgent, "GET", BOAT_AGENT_NETWORK_ROUTE, { bearer: otherBearer })).body,
          ).docker_policy === "failed",
      );
    },
  );

  it("never restarts a daemon under a park that completed while the recovery's body arrived", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    const first = await readDaemonRecord(vm);
    const pending = await partialBody(agent, AGENT_RECOVER_ROUTE, bearer, recoverBody);
    const operationId = randomUUID();
    const parked = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });
    expect(parked.status).toBe(200);
    pending.finish();
    expect(await pending.reply).toMatchObject({ status: 409, body: { reason: "parked" } });
    expect((await readDaemonRecord(vm)).pid).toBe(first.pid);
  });
});

// --------------------------------------------------------------------------------------------
// An agent restarted on the same boot (issue #513)
// --------------------------------------------------------------------------------------------

const systemctlLines = async (vm: Vm) =>
  (await readFile(vm.systemctlLog, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line !== "");
const launchEnvFile = (vm: Vm) => path.join(vm.stateDir, "agent", "launch-env.json");

describe("boat agent · restarted on the same boot", () => {
  const park = (agent: Agent, bearer: string, operationId: string) =>
    call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
      body: { format: "sealant-agent-park-v1", operationId },
      bearer,
    });
  const health = async (agent: Agent, bearer: string) => {
    const reply = await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer });
    return {
      status: reply.status,
      body: z
        .object({
          booted: z.boolean(),
          controlSocket: z.boolean(),
          daemonExit: z.object({ code: z.number().nullable() }).optional(),
        })
        .parse(reply.body),
    };
  };

  it("keeps what a recovery boot needs on tmpfs, 0600, from the launch on", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    const file = launchEnvFile(vm);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(boatAgentLaunchEnvRecordSchema.parse(JSON.parse(await readFile(file, "utf8")))).toEqual({
      format: "sealant-agent-launch-env-v1",
      boot_id: await vm.bootId(),
      run_id: "run_abc-1",
      contract_version: 1,
      capture_sourced: true,
      flush_timeout_ms: 400,
      boot_env: {
        SEALANT_WORKSPACE_SOURCE: "capture",
        SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
        MEND_SESSION_ID: "1",
        SEALANT_SECRET_ENV_FILE: path.join(vm.stateDir, "secrets", "env.json"),
      },
    });
    // The bearer is the control token: it is on tmpfs already (`arm.json`), never here.
    expect(await readFile(file, "utf8")).not.toContain(bearer);
    expect(agent.port).toBeGreaterThan(0);
  });

  it(
    "parks the daemon an earlier agent process started: the scope is killed and proved gone before any receipt",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const { agent, bearer } = await launched(vm);
      await waitFor(() => exists(vm.socketPath));
      const daemon = await readDaemonRecord(vm);
      await crashAgent(agent);
      expect(alive(daemon.pid)).toBe(true);
      // The daemon's scope is live, and nothing will die for a kill: a scope that will not end.
      await vm.setScope("0badc0de", { sticky: true });
      const restarted = await startAgent(vm);
      // Health is honest about what this process holds: booted, the daemon not exited (its scope
      // is live), the control socket as measured.
      expect(await health(restarted, bearer)).toEqual({
        status: 200,
        body: { booted: true, controlSocket: true },
      });

      const operationId = randomUUID();
      const unverified = await park(restarted, bearer, operationId);
      expect(unverified).toMatchObject({ status: 503, body: { reason: "daemon-stop-unverified" } });
      expect(await exists(path.join(vm.dataDir, `park-${operationId}.json`))).toBe(false);
      expect(await systemctlLines(vm)).toContain(
        "kill --signal=SIGKILL sealant-workspace-0badc0de.scope",
      );
      // Still listed active, but its cgroup reads empty: proved gone, closed on the retry.
      const scopeCgroup = path.join(
        vm.cgroupRoot,
        "sealant-workspace.slice",
        "sealant-workspace-0badc0de.scope",
      );
      await mkdir(scopeCgroup, { recursive: true });
      await writeFile(path.join(scopeCgroup, "cgroup.events"), "populated 0\nfrozen 0\n");
      const closed = await park(restarted, bearer, operationId);
      expect(closed.status).toBe(200);
      expect(boatAgentParkResponseSchema.parse(closed.body).receipt.path).toBe(
        path.join(vm.dataDir, `park-${operationId}.json`),
      );
      expect(await parkReceipt(vm, operationId)).toMatchObject({
        run_id: "run_abc-1",
        daemon: "stopped",
        docker: "absent",
      });
      expect((await readFile(vm.syncLog, "utf8")).trim()).toBe("sync");
    },
  );

  it("parks on a retry once the scope is no longer active", { timeout: 30_000 }, async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await waitFor(() => exists(vm.socketPath));
    await crashAgent(agent);
    await vm.setScope("1badc0de", { sticky: true });
    const restarted = await startAgent(vm);
    const operationId = randomUUID();
    expect(await park(restarted, bearer, operationId)).toMatchObject({
      status: 503,
      body: { reason: "daemon-stop-unverified" },
    });
    // A kill that takes: the scope ends.
    await vm.setScope("1badc0de");
    expect((await park(restarted, bearer, operationId)).status).toBe(200);
    expect((await parkReceipt(vm, operationId)).daemon).toBe("stopped");
    // The scope is gone: health reports the daemon exited, with an exit this process never saw.
    expect(await health(restarted, bearer)).toMatchObject({
      status: 503,
      body: { booted: true, daemonExit: { code: null } },
    });
  });

  it(
    "recovers from the adopted launch: `running` while the scope is live, then a recovery boot from its environment",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm, {
        SEALANT_MICROVM_DOCKER_CAPABLE: "1",
        SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
        FAKE_SEALANTD_EXIT75: "1",
      });
      expect(
        (
          await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
            body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
            bearer,
          })
        ).status,
      ).toBe(200);
      await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75, 10_000);
      const first = await readDaemonRecord(vm);
      await crashAgent(agent);

      await vm.setScope("2badc0de");
      const restarted = await startAgent(vm, { SEALANT_MICROVM_DOCKER_CAPABLE: "1" });
      const running = await call(restarted, "POST", AGENT_RECOVER_ROUTE, {
        body: recoverBody,
        bearer,
      });
      expect(running.status).toBe(200);
      expect(boatAgentRecoverResponseSchema.parse(running.body)).toEqual({ outcome: "running" });
      expect((await readDaemonRecord(vm)).pid).toBe(first.pid);
      expect(await health(restarted, bearer)).toMatchObject({
        body: { booted: true, controlSocket: false },
      });
      expect((await health(restarted, bearer)).body).not.toHaveProperty("daemonExit");

      await vm.setScope(null);
      const recovered = await call(restarted, "POST", AGENT_RECOVER_ROUTE, {
        body: recoverBody,
        bearer,
      });
      expect(recovered.status).toBe(200);
      expect(boatAgentRecoverResponseSchema.parse(recovered.body)).toEqual({
        outcome: "restarted",
      });
      await waitFor(async () => (await readDaemonRecord(vm)).argv.includes("--recovery"));
      const recovery = await readDaemonRecord(vm);
      expect(recovery.argv).toEqual(["boot", "--recovery"]);
      // The adopted boot env, less Docker (#520) and the dotfiles, plus the capture token.
      expect(recovery.env).toMatchObject({
        SEALANT_WORKSPACE_SOURCE: "capture",
        SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
        MEND_SESSION_ID: "1",
        SEALANT_CONTROL_SOCKET: vm.socketPath,
        SEALANT_SECRET_ENV_FILE: path.join(vm.stateDir, "secrets", "env.json"),
      });
      for (const key of [
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "SEALANT_WORKSPACE_DOCKER_HOST",
        "SEALANT_DOTFILES_ARCHIVE_DIR",
        "SEALANT_SWEEP_EXEMPT_FILE",
      ]) {
        expect(recovery.env).not.toHaveProperty(key);
      }
      expect(
        JSON.parse(await readFile(path.join(vm.stateDir, "secrets", "env.json"), "utf8")),
      ).toEqual({ SEALANT_CAPTURE_TOKEN: "mst_recovery_token" });
      // Docker's cgroups were looked at before anything started: the containers' slice resolved
      // from systemd, as the service does.
      expect(await systemctlLines(vm)).toContain(
        "show --property ControlGroup --value sealant-docker.slice",
      );
    },
  );

  it(
    "never closes a park over a live scope, even without a launch to adopt",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
      await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
      await crashAgent(agent);
      await rm(launchEnvFile(vm));
      await vm.setScope("3badc0de", { sticky: true });
      const restarted = await startAgent(vm);
      expect(
        await call(restarted, "POST", AGENT_RECOVER_ROUTE, { body: recoverBody, bearer }),
      ).toMatchObject({ status: 409, body: { reason: "recover-state-unknown" } });
      const operationId = randomUUID();
      expect(await park(restarted, bearer, operationId)).toMatchObject({
        status: 503,
        body: { reason: "daemon-stop-unverified" },
      });
      expect(await exists(path.join(vm.dataDir, `park-${operationId}.json`))).toBe(false);
      await vm.setScope(null);
      expect((await park(restarted, bearer, operationId)).status).toBe(200);
    },
  );

  it("adopts nothing across a reboot: the launch environment is another boot's", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm, { FAKE_SEALANTD_EXIT75: "1" });
    await waitFor(async () => (await daemonExitCode(agent, bearer)) === 75);
    const first = await readDaemonRecord(vm);
    await crashAgent(agent);
    await vm.reboot();
    // In reality tmpfs is empty after a reboot; here the file is there and its boot id is not.
    expect(await exists(launchEnvFile(vm))).toBe(true);
    const rebooted = await startAgent(vm);
    expect(rebooted.output()).not.toContain("adopted");
    const refused = await call(rebooted, "POST", AGENT_RECOVER_ROUTE, {
      body: recoverBody,
      bearer,
    });
    expect(refused.status).toBe(409);
    expect(boatAgentRefusalSchema.parse(refused.body)).toEqual({ reason: "recover-new-boot" });
    expect((await readDaemonRecord(vm)).pid).toBe(first.pid);
  });

  it(
    "parks a Docker session an earlier agent process started only once Docker's cgroups are proved empty",
    { timeout: 30_000 },
    async () => {
      const vm = await createVm();
      const bearer = await bindVm(vm);
      const agent = await startAgent(vm, {
        SEALANT_MICROVM_DOCKER_CAPABLE: "1",
        SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "5000",
      });
      expect(
        (
          await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
            body: launchBody(bearer, { version: 2, services: { docker: "required" } }),
            bearer,
          })
        ).status,
      ).toBe(200);
      await waitFor(
        async () => (await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer })).status === 200,
        10_000,
      );
      await crashAgent(agent);
      // dockerd outlived the agent in the engine cgroup; so did a container in the slice.
      const engine = path.join(vm.cgroupRoot, "sealant-docker-engine");
      const slice = path.join(vm.cgroupRoot, "sealant.slice", "sealant-docker.slice");
      await writeFile(path.join(engine, "cgroup.events"), "populated 1\nfrozen 0\n");
      await writeFile(path.join(slice, "cgroup.events"), "populated 1\nfrozen 0\n");
      const restarted = await startAgent(vm, { SEALANT_MICROVM_DOCKER_CAPABLE: "1" });
      const operationId = randomUUID();
      expect(await park(restarted, bearer, operationId)).toMatchObject({
        status: 503,
        body: { reason: "docker-stop-unverified" },
      });
      expect(await exists(path.join(vm.dataDir, `park-${operationId}.json`))).toBe(false);
      expect(await readFile(path.join(engine, "cgroup.kill"), "utf8")).toBe("1");
      expect(await readFile(path.join(slice, "cgroup.kill"), "utf8")).toBe("1");
      await writeFile(path.join(engine, "cgroup.events"), "populated 0\nfrozen 0\n");
      expect(await park(restarted, bearer, operationId)).toMatchObject({
        status: 503,
        body: { reason: "docker-stop-unverified" },
      });
      await writeFile(path.join(slice, "cgroup.events"), "populated 0\nfrozen 0\n");
      expect((await park(restarted, bearer, operationId)).status).toBe(200);
      expect(await parkReceipt(vm, operationId)).toMatchObject({
        daemon: "stopped",
        docker: "stopped",
      });
    },
  );
});

describe("boat agent · typed failures", () => {
  it("names the network setup step that failed, never the error's text", async () => {
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    await writeFile(`${vm.netLog}.fail-ip-route`, "");
    const routed = await call(agent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
      body: networkBody(),
      bearer,
    });
    expect(routed).toEqual({ status: 500, body: { reason: "network-route-failed" } });

    const other = await createVm();
    const resolver = await launched(other, {
      // A resolver path under a regular file cannot be written: the last step fails.
      SEALANT_AGENT_RESOLV_CONF: path.join(other.bootIdFile, "resolv.conf"),
    });
    expect(
      await call(resolver.agent, "POST", BOAT_AGENT_NETWORK_ROUTE, {
        body: networkBody(),
        bearer: resolver.bearer,
      }),
    ).toEqual({ status: 500, body: { reason: "network-resolver-failed" } });
  });

  it("answers an unexpected route failure with a typed reason, not 'request failed'", async () => {
    if (process.getuid?.() === 0) return;
    const vm = await createVm();
    const { agent, bearer } = await launched(vm);
    // The receipt cannot be written: the park fails for a reason that is not a refusal.
    await chmod(vm.dataDir, 0o500);
    try {
      const parked = await call(agent, "POST", BOAT_AGENT_PARK_ROUTE, {
        body: { format: "sealant-agent-park-v1", operationId: randomUUID() },
        bearer,
      });
      expect(parked).toEqual({ status: 500, body: { reason: "park-failed" } });
    } finally {
      await chmod(vm.dataDir, 0o700);
    }
  });
});
