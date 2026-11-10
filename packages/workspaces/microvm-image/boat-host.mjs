// The Boat host mode of the Sealant guest agent (`agent.mjs` with `SEALANT_AGENT_HOST=boat`).
//
// On Boat the VM is the workspace: this agent runs as a root systemd service, sealantd runs as
// PID 1 of its own PID namespace, and nothing Lambda-shaped happens (no lifecycle hooks, no run
// payload). What replaces the run hook is the bind exchange (`boat-bind.mjs`, run by Core over
// Boat exec): it leaves a bearer on tmpfs that the agent arms itself with lazily, and that bearer
// is both the launch secret and the control token. What a Lambda VM keeps in the agent's memory,
// a Boat VM keeps on disk as well, keyed by boot id, so an agent restarted on the same boot knows
// whether the launch was accepted and a recovery can be answered with a typed outcome instead of
// a guess. This module is that knowledge; `agent.mjs` keeps the daemon and the routes.
//
// Everything here mirrors `src/runtime/boat/agent-contract.ts` by hand: the image's Node has
// nothing but its standard library.
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const BIND_RECORD_FORMAT = "sealant-agent-bind-v1";
export const ARM_RECORD_FORMAT = "sealant-agent-arm-v1";
export const LAUNCH_RECORD_FORMAT = "sealant-agent-launch-v1";
export const PARK_REQUEST_FORMAT = "sealant-agent-park-v1";
export const PARK_RECEIPT_FORMAT = "sealant-agent-park-receipt-v1";
export const NETWORK_REQUEST_FORMAT = "sealant-guest-network-v1";
export const NETWORK_STATUS_FORMAT = "sealant-guest-network-status-v1";
export const NETWORK_RECORD_FORMAT = "sealant-agent-network-v1";

/** The identity names Boat's receiver accepted; the bind CLI accepts exactly these. */
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const IDENTITY_KEYS = ["deployment_id", "instance_id", "disk_lineage"];

export const WIREGUARD_INTERFACE = "sealant-wg";
export const GATEWAY = "100.127.255.253";
export const CLIENT = "100.127.255.254";
const WIREGUARD_MTU = "1380";
const RESOLV_CONF_BYTES = `nameserver ${GATEWAY}\noptions timeout:2 attempts:2\n`;
/** `guest_network.DENIED`: what a container may never reach, in this order. */
/** Docker's own networks (`--bip` and `--default-address-pool`, set by the Boat image). */
export const DOCKER_NETWORKS = ["198.18.1.0/24", "198.19.0.0/16"];

export const DENIED = [
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
const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const COMMAND_TIMEOUT_MS = 5_000;
const DNS_TIMEOUT_MS = 2_000;

// --------------------------------------------------------------------------------------------
// Paths and records
// --------------------------------------------------------------------------------------------

/** Where the Boat host keeps its state, from the environment (overridable for tests). */
export const boatPaths = (env = process.env) => {
  const stateDir = env.SEALANT_MICROVM_AGENT_STATE_DIR ?? "/run/sealant";
  const dataDir = env.SEALANT_AGENT_DATA_DIR ?? "/var/lib/sealant/agent";
  return {
    bootIdFile: env.SEALANT_AGENT_BOOT_ID_FILE ?? "/proc/sys/kernel/random/boot_id",
    manifestFile: env.SEALANT_AGENT_MANIFEST_FILE ?? path.join(dataDir, "manifest.json"),
    stateDir,
    dataDir,
    /** The bearer: tmpfs only, never on the disk. */
    armFile: path.join(stateDir, "agent", "arm.json"),
    bindFile: path.join(dataDir, "bind.json"),
    launchFile: path.join(dataDir, "launch.json"),
    networkFile: path.join(dataDir, "network.json"),
    resolvConfOriginal: path.join(dataDir, "resolv.conf.orig"),
    resolvConf: env.SEALANT_AGENT_RESOLV_CONF ?? "/etc/resolv.conf",
    parkReceipt: (operationId) => path.join(dataDir, `park-${operationId}.json`),
  };
};

/**
 * Whether the disk holds a park receipt written on `bootId`: that boot's workspace was closed
 * for parking (daemon and Docker stopped, synced) before its VM was saved.
 */
export const parkedOnBoot = (paths, bootId) => {
  let names;
  try {
    names = readdirSync(paths.dataDir);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!/^park-[0-9a-f-]{36}\.json$/.test(name)) return false;
    const receipt = readRecord(path.join(paths.dataDir, name));
    return (
      receipt.kind === "ok" &&
      receipt.value.format === PARK_RECEIPT_FORMAT &&
      receipt.value.boot_id === bootId
    );
  });
};

/** The current boot's id, read at each use; throws when the VM cannot say. */
export const readBootId = (file) => {
  const value = readFileSync(file, "utf8").trim();
  if (!UUID_PATTERN.test(value)) throw new Error("boot id is not a uuid");
  return value;
};

/**
 * Write a record so no reader can ever see it half-written: a temp file in the same directory,
 * given its final mode before it holds any bytes, fsynced, renamed over the target (atomic within
 * a filesystem), then the directory fsynced (durability of the rename itself, best effort).
 */
export const writeAtomic = async (file, content, mode) => {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const dirHandle = await open(dir, "r").catch(() => null);
  if (dirHandle !== null) {
    await dirHandle.sync().catch(() => {});
    await dirHandle.close();
  }
};

/** A JSON record: `absent`, `ok` with its value, or `unreadable` (there, but not a JSON object). */
export const readRecord = (file) => {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { kind: "ok", value, raw }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameKeys = (value, keys) =>
  isPlainObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export const isIdentity = (value) =>
  sameKeys(value, IDENTITY_KEYS) &&
  IDENTITY_KEYS.every((key) => typeof value[key] === "string" && NAME_PATTERN.test(value[key]));

/** Structural equality of JSON values (objects compared key by key, order aside). */
export const sameJson = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameJson(a[key], b[key]));
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A JSON record as the Python guest wrote them: sorted keys, one line. */
const canonical = (value) => {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : isPlainObject(item)
        ? Object.fromEntries(
            Object.keys(item)
              // A fresh array (keys is one), and the image's Node may predate toSorted.
              // oxlint-disable-next-line unicorn/no-array-sort
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return `${JSON.stringify(sort(value))}\n`;
};

// --------------------------------------------------------------------------------------------
// Commands (never a shell; never the input in an error)
// --------------------------------------------------------------------------------------------

/**
 * Run a program with arguments and optional stdin, bounded. Resolves to its exit code and
 * stdout; a program that cannot start or overruns is a non-zero code. Nothing from `input`
 * (the WireGuard private key) is ever part of a result or an error.
 */
const run = async (program, args, { input = null, timeoutMs = COMMAND_TIMEOUT_MS } = {}) => {
  // A program that cannot start is an `error` event, not a throw (`once` rejects on it); a late
  // error after the close must not be unhandled.
  const child = spawn(program, args, {
    stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  });
  child.on("error", () => {});
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-65536);
  });
  if (input !== null) {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  // An overrun is killed; its close then reports a null code.
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code] = await once(child, "close");
    return { code, stdout };
  } catch {
    return { code: null, stdout };
  } finally {
    clearTimeout(timer);
  }
};

// --------------------------------------------------------------------------------------------
// Network config validation (`guest_network.parse`)
// --------------------------------------------------------------------------------------------

class Refusal extends Error {
  constructor(reason, status = 400) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

const NETWORK_KEYS = [
  "format",
  "binding",
  "private_key",
  "public_key",
  "gateway_key",
  "endpoint",
  "port",
  "subnet",
];

const validKey = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Refusal("invalid-network-key");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32 || raw.every((byte) => byte === 0) || raw.toString("base64") !== value) {
    throw new Refusal("invalid-network-key");
  }
  return value;
};

/** An IPv4 address as a 32-bit number, or `null`: four decimal octets, no leading zeros. */
const parseIPv4 = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
};

const parseNetwork = (value) => {
  if (typeof value !== "string") return null;
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || prefix === undefined || !/^(0|[1-9]\d?)$/.test(prefix)) return null;
  const length = Number(prefix);
  if (length > 32) return null;
  const base = parseIPv4(address);
  if (base === null) return null;
  const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
  return { base, length, mask };
};

const inNetwork = (address, network) => (address & network.mask) >>> 0 === network.base;

const subnetOf = (subnet, parent) =>
  subnet.length >= parent.length && inNetwork(subnet.base, parent);

/** `guest_network.parse`: the config exactly, or a refusal with the Python guest's reason. */
export const parseNetworkConfig = (value) => {
  if (!sameKeys(value, NETWORK_KEYS) || value.format !== NETWORK_REQUEST_FORMAT) {
    throw new Refusal("invalid-network-config");
  }
  for (const name of ["private_key", "public_key", "gateway_key"]) validKey(value[name]);
  const endpoint = parseIPv4(value.endpoint);
  const subnet = parseNetwork(value.subnet);
  if (endpoint === null || subnet === null) throw new Refusal("invalid-network-destination");
  const unspecified = endpoint === 0;
  const loopback = inNetwork(endpoint, parseNetwork("127.0.0.0/8"));
  const multicast = inNetwork(endpoint, parseNetwork("224.0.0.0/4"));
  const linkLocal = inNetwork(endpoint, parseNetwork("169.254.0.0/16"));
  const strict = (subnet.base & subnet.mask) >>> 0 === subnet.base;
  if (
    unspecified ||
    loopback ||
    multicast ||
    linkLocal ||
    subnet.length !== 27 ||
    !strict ||
    !RFC1918.some((parent) => subnetOf(subnet, parseNetwork(parent))) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    throw new Refusal("invalid-network-destination");
  }
  return value;
};

/** The config without its private key: what may be recorded, logged or compared. */
export const publicNetworkConfig = (config) =>
  Object.fromEntries(Object.entries(config).filter(([key]) => key !== "private_key"));

// --------------------------------------------------------------------------------------------
// DNS probe (`guest_readiness.DNS_PROBE`)
// --------------------------------------------------------------------------------------------

const encodeName = (labels) =>
  Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);

/**
 * Ask the gateway's resolver an unpredictable question over UDP and over TCP; both must echo the
 * question and answer with the gateway's own address. `true` only when both did.
 */
export const probeDns = async ({ host, port }) => {
  const nonce = randomBytes(16).toString("hex");
  const question = Buffer.concat([
    encodeName([nonce, "sealant", "gateway", "invalid"]),
    Buffer.from([0, 1, 0, 1]),
  ]);
  const id = randomBytes(2).readUInt16BE(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const query = Buffer.concat([header, question]);
  const expectedAddress = Buffer.from(GATEWAY.split(".").map(Number));
  const valid = (answer) =>
    answer.length >= 12 + question.length + 4 &&
    answer.readUInt16BE(0) === id &&
    (answer.readUInt16BE(2) & 0x800f) === 0x8000 &&
    answer.readUInt16BE(4) === 1 &&
    answer.readUInt16BE(6) === 1 &&
    answer.subarray(12, 12 + question.length).equals(question) &&
    answer.subarray(answer.length - 4).equals(expectedAddress);

  // Every failure (no answer in time, a send or connect error, a short or wrong answer) is
  // `false`; the sockets never outlive the probe.
  const udp = async () => {
    const socket = dgram.createSocket("udp4");
    socket.on("error", () => {});
    try {
      socket.send(query, port, host);
      const [message] = await once(socket, "message", {
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      });
      return valid(message);
    } catch {
      return false;
    } finally {
      socket.close();
    }
  };
  const tcp = async () => {
    const socket = net.connect({ host, port });
    socket.on("error", () => {});
    socket.setTimeout(DNS_TIMEOUT_MS, () => socket.destroy(new Error("dns-timeout")));
    try {
      await once(socket, "connect", { signal: AbortSignal.timeout(DNS_TIMEOUT_MS) });
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([prefix, query]));
      let pending = Buffer.alloc(0);
      for await (const chunk of socket) {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 2) continue;
        const length = pending.readUInt16BE(0);
        if (pending.length < 2 + length) continue;
        return valid(pending.subarray(2, 2 + length));
      }
      return false;
    } catch {
      return false;
    } finally {
      socket.destroy();
    }
  };
  const [overUdp, overTcp] = await Promise.all([udp(), tcp()]);
  return overUdp && overTcp;
};

// --------------------------------------------------------------------------------------------
// The host
// --------------------------------------------------------------------------------------------

/**
 * The Boat host: what `agent.mjs` asks in Boat mode. `log` is the agent's logger; `env` the
 * agent's environment (command paths and test overrides come from it).
 */
export const createBoatHost = ({ env = process.env, log, dockerCapable = false }) => {
  const paths = boatPaths(env);
  const commands = {
    ip: env.SEALANT_AGENT_IP ?? "ip",
    wg: env.SEALANT_AGENT_WG ?? "wg",
    iptables: env.SEALANT_AGENT_IPTABLES ?? "iptables",
    iptablesRestore: env.SEALANT_AGENT_IPTABLES_RESTORE ?? "iptables-restore",
    ip6tables: env.SEALANT_AGENT_IP6TABLES ?? "ip6tables",
    ip6tablesRestore: env.SEALANT_AGENT_IP6TABLES_RESTORE ?? "ip6tables-restore",
    modprobe: env.SEALANT_AGENT_MODPROBE ?? "modprobe",
    sync: env.SEALANT_AGENT_SYNC ?? "sync",
    unshare: env.SEALANT_AGENT_UNSHARE ?? "unshare",
    systemdRun: env.SEALANT_AGENT_SYSTEMD_RUN ?? "systemd-run",
  };
  const daemonNamespace = env.SEALANT_AGENT_DAEMON_NAMESPACE === "none" ? "none" : "pid";
  // Where the kernel's sysctls are (tests point it at a scratch tree).
  const procSys = env.SEALANT_AGENT_PROC_SYS ?? "/proc/sys";
  const dnsProbe = {
    host: env.SEALANT_AGENT_DNS_PROBE_HOST ?? GATEWAY,
    port: Number(env.SEALANT_AGENT_DNS_PROBE_PORT ?? 53),
  };

  const host = {
    /** The park this agent is performing or has performed (operation id), if any. */
    parked: null,
    parking: null,
    dockerReady: false,
    policy: Promise.resolve(),
    /** The Docker policy: `absent` (no Docker), `pending`, `applied` or `failed`. */
    policyState: dockerCapable ? "pending" : "absent",
  };

  const bootId = () => {
    try {
      return readBootId(paths.bootIdFile);
    } catch {
      return null;
    }
  };

  /** The bind record when it is this boot's; `null` otherwise (absent, unreadable, another boot). */
  const currentBind = () => {
    const boot = bootId();
    const bind = readRecord(paths.bindFile);
    if (
      boot === null ||
      bind.kind !== "ok" ||
      bind.value.format !== BIND_RECORD_FORMAT ||
      bind.value.boot_id !== boot
    ) {
      return null;
    }
    return bind.value;
  };

  /** The launch record: `absent`, `unreadable`, or `ok` with its value (any boot). */
  const launchRecord = () => {
    const launch = readRecord(paths.launchFile);
    if (launch.kind !== "ok") return launch;
    const value = launch.value;
    if (
      value.format !== LAUNCH_RECORD_FORMAT ||
      typeof value.boot_id !== "string" ||
      typeof value.run_id !== "string"
    ) {
      return { kind: "unreadable" };
    }
    return launch;
  };

  /**
   * Arm the agent from the bind the CLI left, when it has none yet: the bearer on tmpfs is both
   * the launch secret and the control token (so health, control, recover, park and network are
   * authorised before any launch). Only a bind of this boot counts.
   */
  const arm = (state, contractVersion) => {
    if (state.launchSecret !== null || state.controlToken !== null) return;
    const bind = currentBind();
    if (bind === null) return;
    const armRecord = readRecord(paths.armFile);
    if (
      armRecord.kind !== "ok" ||
      armRecord.value.format !== ARM_RECORD_FORMAT ||
      armRecord.value.boot_id !== bind.boot_id ||
      typeof armRecord.value.bearer !== "string" ||
      !/^[a-f0-9]{64}$/.test(armRecord.value.bearer)
    ) {
      return;
    }
    state.launchSecret = armRecord.value.bearer;
    state.controlToken = armRecord.value.bearer;
    state.contractVersion = contractVersion;
    log(`armed by the bind of boot ${bind.boot_id} (operation ${bind.operation_id})`);
  };

  /** Whether a launch was accepted on this boot (by this agent process or an earlier one). */
  const launchAccepted = () => {
    const boot = bootId();
    const launch = launchRecord();
    return launch.kind === "ok" && boot !== null && launch.value.boot_id === boot;
  };

  /** The durable launch record, written (fsync) BEFORE sealantd starts. */
  const recordLaunch = async (runId) => {
    const boot = bootId();
    if (boot === null) throw new Error("the VM's boot id cannot be read");
    await writeAtomic(
      paths.launchFile,
      canonical({
        format: LAUNCH_RECORD_FORMAT,
        boot_id: boot,
        run_id: runId,
        accepted_at: new Date().toISOString(),
      }),
      0o644,
    );
  };

  /**
   * How sealantd is started: as PID 1 of its own PID namespace, in a transient systemd scope of
   * its own (`sealant-workspace-<id>.scope` under `sealant-workspace.slice`), unless told `none`
   * (tests). The scope keeps the workspace's memory apart from the agent's: an OOM kill in it
   * takes one of its processes (`OOMPolicy=continue`), never the agent, and never the unit. The
   * agent's process is what it was: `systemd-run --scope` registers the scope and execs in place,
   * so the child the agent spawned is the namespace's wrapper, and its process group is still what
   * a park or recovery kills. The name is fresh per start: a recovery boot on the same boot must
   * not wait for the ended scope to be collected.
   */
  const daemonCommand = (sealantd, args) =>
    daemonNamespace === "pid"
      ? [
          commands.systemdRun,
          "--scope",
          "--quiet",
          "--collect",
          `--unit=sealant-workspace-${randomBytes(4).toString("hex")}`,
          "--slice=sealant-workspace",
          "--property=OOMPolicy=continue",
          "--",
          commands.unshare,
          "--pid",
          "--fork",
          "--mount-proc",
          "--kill-child",
          "--",
          sealantd,
          ...args,
        ]
      : [sealantd, ...args];

  /**
   * What a recovery request may do, from the records: a refusal `{reason}`, `nothing-to-save`
   * (bound this boot, never launched), or `proceed`. `agentLaunched`: whether THIS agent process
   * accepted the launch (and so holds the boot env a recovery starts from).
   */
  const recoverDecision = ({ runId, agentLaunched, agentActive }) => {
    const boot = bootId();
    if (boot === null) return { kind: "refuse", reason: "recover-state-unknown" };
    const bind = readRecord(paths.bindFile);
    if (bind.kind === "unreadable") return { kind: "refuse", reason: "recover-state-unknown" };
    if (bind.kind === "absent" || bind.value.boot_id !== boot) {
      return { kind: "refuse", reason: "recover-new-boot" };
    }
    const launch = launchRecord();
    if (launch.kind === "unreadable") return { kind: "refuse", reason: "recover-state-unknown" };
    // `nothing-to-save` is a positive fact: bound this boot, no launch recorded, and this agent
    // neither launching nor holding a daemon. Anything else without a record is not known.
    if (launch.kind === "absent") {
      return agentActive
        ? { kind: "refuse", reason: "recover-state-unknown" }
        : { kind: "nothing-to-save" };
    }
    if (launch.value.boot_id !== boot) return { kind: "refuse", reason: "recover-new-boot" };
    if (launch.value.run_id !== runId) {
      return { kind: "refuse", reason: "recover-binding-conflict" };
    }
    if (!agentLaunched) return { kind: "refuse", reason: "recover-state-unknown" };
    return { kind: "proceed" };
  };

  /**
   * Whether `header` presents the bearer of a bind from ANOTHER boot of this VM: after a reboot
   * the tmpfs bearer is gone, so the agent is not armed, but a recovery Core sends with that
   * bearer deserves a typed `recover-new-boot`, never a 401 that reads like a wrong credential.
   */
  const staleBootBearer = (header) => {
    const boot = bootId();
    const bind = readRecord(paths.bindFile);
    if (
      boot === null ||
      bind.kind !== "ok" ||
      bind.value.format !== BIND_RECORD_FORMAT ||
      bind.value.boot_id === boot ||
      typeof bind.value.bearer_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(bind.value.bearer_sha256) ||
      typeof header !== "string" ||
      !header.startsWith("Bearer ")
    ) {
      return false;
    }
    const presented = sha256(header.slice("Bearer ".length));
    return timingSafeEqual(Buffer.from(presented), Buffer.from(bind.value.bearer_sha256));
  };

  // ---- Park -------------------------------------------------------------------------------

  /** Whether this boot was parked: by this process, or by a receipt of this boot on the disk. */
  const isParked = () => {
    if (host.parked !== null) return true;
    const boot = bootId();
    let names;
    try {
      names = readdirSync(paths.dataDir);
    } catch {
      return false;
    }
    for (const name of names) {
      const match = /^park-([0-9a-f-]{36})\.json$/.exec(name);
      if (match === null) continue;
      const receipt = readRecord(path.join(paths.dataDir, name));
      if (receipt.kind === "ok" && receipt.value.boot_id === boot) {
        host.parked = match[1];
        return true;
      }
    }
    return false;
  };

  const receiptResponse = async (file) => {
    const bytes = await readFile(file);
    return {
      outcome: "closed",
      receipt: { path: file, sha256: sha256(bytes), bytes: bytes.length },
    };
  };

  /**
   * Close the workspace for parking, once per operation: stop the daemon's namespace and Docker
   * (the caller's `stopDaemon` / `stopDocker`), `sync`, write the receipt. The same operation
   * again returns the receipt it wrote; another operation after a park is refused.
   */
  const park = async (body, { runId, stopDaemon, stopDocker }) => {
    if (
      !sameKeys(body, ["format", "operationId"]) ||
      body.format !== PARK_REQUEST_FORMAT ||
      typeof body.operationId !== "string" ||
      !UUID_PATTERN.test(body.operationId)
    ) {
      return { status: 400, body: { reason: "invalid-park-request" } };
    }
    const operationId = body.operationId;
    const file = paths.parkReceipt(operationId);
    if (existsSync(file)) return { status: 200, body: await receiptResponse(file) };
    if (isParked() && host.parked !== operationId) {
      return { status: 409, body: { reason: "parked" } };
    }
    if (host.parking === null) {
      // From here no launch or recovery is accepted on this boot, whether or not this attempt
      // completes: the daemon is being killed. The same operation can be retried.
      host.parked = operationId;
      host.parking = (async () => {
        const boot = bootId();
        log(`park ${operationId}: closing`);
        await stopDaemon();
        const docker = await stopDocker();
        if (docker === "unverified") {
          // Never a receipt saying Docker stopped when it cannot be proved.
          throw new Refusal("docker-stop-unverified", 503);
        }
        const synced = await run(commands.sync, [], { timeoutMs: 60_000 });
        if (synced.code !== 0) log(`park ${operationId}: sync exited ${String(synced.code)}`);
        await writeAtomic(
          file,
          canonical({
            format: PARK_RECEIPT_FORMAT,
            operation_id: operationId,
            boot_id: boot,
            run_id: runId,
            daemon: "stopped",
            docker,
            closed_at: new Date().toISOString(),
          }),
          0o600,
        );
        log(`park ${operationId}: closed`);
      })();
    }
    try {
      await host.parking;
    } catch (error) {
      host.parking = null;
      log(`park ${operationId}: not closed (${error instanceof Refusal ? error.reason : "error"})`);
      if (error instanceof Refusal) return { status: error.status, body: { reason: error.reason } };
      throw error;
    }
    return { status: 200, body: await receiptResponse(file) };
  };

  // ---- Network ----------------------------------------------------------------------------

  const networkRecord = () => {
    const boot = bootId();
    const record = readRecord(paths.networkFile);
    if (
      boot === null ||
      record.kind !== "ok" ||
      record.value.format !== NETWORK_RECORD_FORMAT ||
      record.value.boot_id !== boot ||
      !isPlainObject(record.value.config)
    ) {
      return null;
    }
    return { ...record.value, raw: record.raw };
  };

  const ip = async (...args) => {
    const result = await run(commands.ip, args);
    if (result.code !== 0) throw new Refusal("network-command-refused", 500);
    return result.stdout.trim();
  };

  /** Keep the VM's own resolver once (its symlink target and bytes), then point it at the gateway. */
  const replaceResolvConf = async () => {
    if (!existsSync(paths.resolvConfOriginal)) {
      let symlinkTarget = null;
      let content = null;
      try {
        if (lstatSync(paths.resolvConf).isSymbolicLink()) {
          symlinkTarget = readlinkSync(paths.resolvConf);
        }
        content = readFileSync(paths.resolvConf);
      } catch {
        // No resolver to keep.
      }
      await writeAtomic(
        paths.resolvConfOriginal,
        JSON.stringify({
          symlink: symlinkTarget,
          contentBase64: content === null ? null : content.toString("base64"),
        }),
        0o600,
      );
    }
    // rename replaces the symlink itself, not what it points at.
    await writeAtomic(paths.resolvConf, RESOLV_CONF_BYTES, 0o644);
    await chmod(paths.resolvConf, 0o644);
  };

  /**
   * Undo `replaceResolvConf` once the tunnel it served is gone: a VM rebooted, or restored from a
   * saved snapshot, has no tunnel yet (the network record is another boot's, or none) but its
   * `resolv.conf` still names the gateway, so nothing on it resolves until Core configures the
   * network again. Put the VM's own resolver back (the symlink as it was, else the bytes) and
   * forget the kept copy: the next configure keeps the current one afresh. Called at agent start;
   * a restart on the boot that configured the tunnel keeps the gateway. `true` when restored.
   */
  const restoreResolvConf = async () => {
    if (networkRecord() !== null) return false;
    const kept = readRecord(paths.resolvConfOriginal);
    if (kept.kind !== "ok") return false;
    const { symlink: target, contentBase64 } = kept.value;
    if (typeof target === "string") {
      // The symlink is made beside the file and renamed over it: never a moment without one.
      const temp = `${paths.resolvConf}.${String(process.pid)}.tmp`;
      await unlink(temp).catch(() => {});
      await symlink(target, temp);
      await rename(temp, paths.resolvConf);
    } else if (typeof contentBase64 === "string") {
      await writeAtomic(paths.resolvConf, Buffer.from(contentBase64, "base64"), 0o644);
      await chmod(paths.resolvConf, 0o644);
    } else {
      await unlink(paths.resolvConf).catch(() => {});
    }
    await unlink(paths.resolvConfOriginal);
    log("network: the VM's own resolver is back (no tunnel on this boot)");
    return true;
  };

  /**
   * Bring the interface up in the VM's own namespace. The private key reaches wg through a 0600
   * file on tmpfs that exists only for the call: `wg` opens its key file by path, and a child's
   * stdin from Node is a socketpair, which `/dev/stdin` cannot reopen (ENXIO).
   */
  const prepareNetwork = async (config) => {
    await ip("link", "add", WIREGUARD_INTERFACE, "type", "wireguard");
    const keyFile = path.join(paths.stateDir, "agent", `${WIREGUARD_INTERFACE}.key`);
    await writeAtomic(keyFile, `${config.private_key}\n`, 0o600);
    let set;
    try {
      set = await run(commands.wg, [
        "set",
        WIREGUARD_INTERFACE,
        "private-key",
        keyFile,
        "peer",
        config.gateway_key,
        "endpoint",
        `${config.endpoint}:${String(config.port)}`,
        "allowed-ips",
        `${config.subnet},${GATEWAY}/32`,
        "persistent-keepalive",
        "25",
      ]);
    } finally {
      await unlink(keyFile).catch(() => {});
    }
    if (set.code !== 0) throw new Refusal("network-command-refused", 500);
    await ip("address", "add", `${CLIENT}/32`, "dev", WIREGUARD_INTERFACE);
    await ip("link", "set", WIREGUARD_INTERFACE, "mtu", WIREGUARD_MTU);
    await ip("link", "set", WIREGUARD_INTERFACE, "up");
    await ip("route", "add", config.subnet, "dev", WIREGUARD_INTERFACE);
    await ip("route", "add", `${GATEWAY}/32`, "dev", WIREGUARD_INTERFACE);
    await replaceResolvConf();
  };

  /** A configured network is still there: the interface exists and the resolver is ours. */
  const verifyNetwork = async () => {
    const link = await run(commands.ip, ["link", "show", "dev", WIREGUARD_INTERFACE]);
    let resolver = null;
    try {
      resolver = readFileSync(paths.resolvConf, "utf8");
    } catch {
      // Absent: not ours.
    }
    if (link.code !== 0 || resolver !== RESOLV_CONF_BYTES) {
      throw new Refusal("network-state-changed", 409);
    }
  };

  const networkReply = (config, raw) => ({
    format: NETWORK_STATUS_FORMAT,
    binding: config.binding,
    receipt: sha256(raw),
    configured: true,
    handshake: "unverified",
  });

  /**
   * `POST /sealant/network`: record the public intent, then configure. The same config again is
   * verified and answered without a change; a different one on this boot is a conflict.
   */
  const configureNetwork = async (body) => {
    let config;
    try {
      config = parseNetworkConfig(body);
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, body: { reason: error.reason } };
      throw error;
    }
    const intent = publicNetworkConfig(config);
    const existing = networkRecord();
    try {
      if (existing !== null) {
        if (!sameJson(existing.config, intent)) {
          return { status: 409, body: { reason: "network-binding-conflict" } };
        }
        if (existing.status !== "configured") {
          return { status: 409, body: { reason: "network-setup-unresolved" } };
        }
        await verifyNetwork();
        void applyDockerPolicy();
        return { status: 200, body: networkReply(config, existing.raw) };
      }
      const boot = bootId();
      if (boot === null) return { status: 409, body: { reason: "network-setup-unresolved" } };
      await writeAtomic(
        paths.networkFile,
        canonical({
          format: NETWORK_RECORD_FORMAT,
          boot_id: boot,
          status: "preparing",
          config: intent,
        }),
        0o644,
      );
      await prepareNetwork(config);
      const configured = canonical({
        format: NETWORK_RECORD_FORMAT,
        boot_id: boot,
        status: "configured",
        config: intent,
      });
      await writeAtomic(paths.networkFile, configured, 0o644);
      log(
        `network: ${WIREGUARD_INTERFACE} configured to ${config.endpoint}:${String(config.port)}`,
      );
      void applyDockerPolicy();
      return { status: 200, body: networkReply(config, configured) };
    } catch (error) {
      if (error instanceof Refusal) {
        log(`network: ${error.reason}`);
        return { status: error.status, body: { reason: error.reason } };
      }
      throw error;
    }
  };

  /** `GET /sealant/network`: measured now — the peer's handshake and the gateway's resolver. */
  const networkStatus = async () => {
    const record = networkRecord();
    if (record === null || record.status !== "configured") {
      return {
        configured: false,
        handshake: "unverified",
        dns: "unavailable",
        docker_policy: host.policyState,
      };
    }
    const [handshakes, dns] = await Promise.all([
      run(commands.wg, ["show", WIREGUARD_INTERFACE, "latest-handshakes"]),
      probeDns(dnsProbe).catch(() => false),
    ]);
    const verified =
      handshakes.code === 0 &&
      handshakes.stdout.split("\n").some((line) => {
        const [key, time] = line.trim().split(/\s+/);
        return key === record.config.gateway_key && /^\d+$/.test(time ?? "") && Number(time) > 0;
      });
    return {
      configured: true,
      handshake: verified ? "verified" : "unverified",
      dns: dns ? "udp-and-tcp" : "unavailable",
      // A Docker image is ready only once containers are held to the gateway's allowance.
      docker_policy: host.policyState,
    };
  };

  // ---- DOCKER-USER policy -----------------------------------------------------------------

  /**
   * Once dockerd is up AND the network is configured (either order), fill the DOCKER-USER chain:
   * what a container may reach is the tunnel's subnet, the gateway's resolver and what it already
   * talks to; the private and special ranges are dropped. Applied whole each time (flush, fill),
   * so it is idempotent. Health does not depend on it; a failure is logged.
   */
  /**
   * What containers may do, as one `iptables-restore` and one `ip6tables-restore` input, so each
   * family's policy changes atomically (`--noflush` keeps Docker's own chains; a chain named in
   * the input is replaced whole):
   * - DOCKER-USER (forwarded traffic of bridged containers): replies; Docker's own networks
   *   (`--bip` 198.18.1.0/24, pools 198.19.0.0/16); the resource subnet and the gateway's DNS
   *   through the tunnel. The tunnel's endpoint and every private, metadata and reserved range
   *   are dropped. Everything else (the Internet) returns to Docker's chains.
   * - SEALANT-DOCKER-INPUT (from INPUT): no new connection from a container to the VM itself,
   *   matched by what a container is, not by a bridge's name (`com.docker.network.bridge.name`
   *   can be anything): Docker's own source ranges, and any packet that entered through a bridge
   *   port (`physdev`; a custom `--subnet` network is caught there too).
   * - IPv6: nothing forwarded for a container at all, and nothing new from a bridge to the VM.
   *   The gateway allows IPv4 only, and an `--ipv6` network must not open what it does not.
   */
  const policyInputs = (record) => {
    const subnet = record.config.subnet;
    const endpoint = record.config.endpoint;
    const fromContainers = [
      ...DOCKER_NETWORKS.map((cidr) => `-s ${cidr}`),
      "-m physdev --physdev-is-in",
    ];
    const v4 = [
      "*filter",
      ":DOCKER-USER - [0:0]",
      ":SEALANT-DOCKER-INPUT - [0:0]",
      "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
      ...DOCKER_NETWORKS.map((cidr) => `-A DOCKER-USER -d ${cidr} -j RETURN`),
      `-A DOCKER-USER -o ${WIREGUARD_INTERFACE} -d ${subnet} -j RETURN`,
      `-A DOCKER-USER -o ${WIREGUARD_INTERFACE} -d ${GATEWAY}/32 -p udp --dport 53 -j RETURN`,
      `-A DOCKER-USER -o ${WIREGUARD_INTERFACE} -d ${GATEWAY}/32 -p tcp --dport 53 -j RETURN`,
      `-A DOCKER-USER -d ${endpoint}/32 -j DROP`,
      ...DENIED.map((cidr) => `-A DOCKER-USER -d ${cidr} -j DROP`),
      "-A DOCKER-USER -j RETURN",
      ...fromContainers.map(
        (match) => `-A SEALANT-DOCKER-INPUT ${match} -m conntrack --ctstate NEW -j DROP`,
      ),
      "COMMIT",
      "",
    ].join("\n");
    const v6 = [
      "*filter",
      ":DOCKER-USER - [0:0]",
      ":SEALANT-DOCKER-INPUT - [0:0]",
      "-A DOCKER-USER -j DROP",
      "-A SEALANT-DOCKER-INPUT -m physdev --physdev-is-in -m conntrack --ctstate NEW -j DROP",
      "COMMIT",
      "",
    ].join("\n");
    return { v4, v6 };
  };

  /**
   * Once dockerd is up AND the network is configured (either order), apply the policy; then make
   * sure INPUT and FORWARD reach its chains. Its state is part of `GET /sealant/network`, so a
   * policy that did not apply refuses readiness instead of failing open.
   */
  const applyDockerPolicy = () => {
    const record = networkRecord();
    if (!host.dockerReady || record === null || record.status !== "configured") {
      return host.policy;
    }
    const { v4, v6 } = policyInputs(record);
    const hooked = async (iptables, chain, target) =>
      (await run(iptables, ["-C", chain, "-j", target])).code === 0 ||
      (await run(iptables, ["-I", chain, "1", "-j", target])).code === 0;
    /**
     * The physdev match only sees bridged packets when bridge netfilter hands them to iptables:
     * load it, turn it on for both families, and read it back. Not on means not applied.
     */
    const bridgeNetfilter = async () => {
      await run(commands.modprobe, ["br_netfilter"]);
      const settings = ["bridge-nf-call-iptables", "bridge-nf-call-ip6tables"].map((name) =>
        path.join(procSys, "net", "bridge", name),
      );
      for (const setting of settings) {
        try {
          await writeFile(setting, "1\n");
        } catch {
          // Read back below: a setting that could not be written is not on.
        }
      }
      return settings.every((setting) => {
        try {
          return readFileSync(setting, "utf8").trim() === "1";
        } catch {
          return false;
        }
      });
    };
    const apply = async () => {
      host.policyState = "pending";
      if (!(await bridgeNetfilter())) {
        host.policyState = "failed";
        log("docker policy: failed (bridge netfilter is not on)");
        return false;
      }
      const restored = await Promise.all([
        run(commands.iptablesRestore, ["--noflush"], { input: v4 }),
        run(commands.ip6tablesRestore, ["--noflush"], { input: v6 }),
      ]);
      const ok =
        restored.every((result) => result.code === 0) &&
        (await hooked(commands.iptables, "INPUT", "SEALANT-DOCKER-INPUT")) &&
        (await hooked(commands.ip6tables, "INPUT", "SEALANT-DOCKER-INPUT")) &&
        (await hooked(commands.ip6tables, "FORWARD", "DOCKER-USER"));
      host.policyState = ok ? "applied" : "failed";
      log(`docker policy: ${host.policyState}`);
      return ok;
    };
    host.policy = host.policy.then(apply, apply);
    return host.policy;
  };

  const markDockerReady = () => {
    host.dockerReady = true;
    void applyDockerPolicy();
  };

  const markDockerStopped = () => {
    host.dockerReady = false;
  };

  return {
    paths,
    bootId,
    arm,
    launchAccepted,
    recordLaunch,
    daemonCommand,
    recoverDecision,
    staleBootBearer,
    isParked,
    park,
    configureNetwork,
    networkStatus,
    restoreResolvConf,
    markDockerReady,
    markDockerStopped,
  };
};
