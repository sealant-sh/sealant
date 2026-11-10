/**
 * Brings up the whole local Boat stack: Postgres, the guest-twin and gateway images, the fake Boat
 * provider with its hosted proxy, a capture channel, and Core's real worker (the production bundle,
 * with its packaged Boat assets) and API (from source), both loaded with `preload.mjs`.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Sealant } from "@sealant/sdk";
import { z } from "zod";

import {
  CACHE_LABEL,
  HARNESS_LABEL,
  docker,
  dockerOk,
  listCoreObjectNames,
  listLabelled,
  removeLabelled,
  type LabelledObjects,
} from "./docker.js";
import { FakeBoat } from "./fake-boat.js";
import { RUN_ENV, acquireHostLock, releaseLock } from "./reap.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../..");

export interface CaptureState {
  readonly endpoint: string;
  readonly head: { readonly n: number; readonly capture_id: string } | null;
  readonly planRequests: number;
  readonly objects: number;
  readonly errors: readonly string[];
}

export interface CaptureSession {
  readonly endpoint: string;
  readonly token: string;
  readonly worktreeId: string;
  /** The channel's view: its head moves when the daemon registers a capture (e.g. FINAL). */
  readonly state: () => Promise<CaptureState>;
}

export interface ManagedProcess {
  readonly name: string;
  readonly log: string;
  child: ChildProcess | undefined;
}

export interface HarnessStack {
  readonly runId: string;
  readonly scratch: string;
  readonly network: string;
  readonly hostIp: string;
  /** The WireGuard endpoint the guests dial: a host address of its own (see `startStack`). */
  readonly gatewayEndpoint: string;
  readonly databaseUrl: string;
  readonly boat: FakeBoat;
  /** Opens a capture session channel (Mend's role) for one worktree, closed with the stack. */
  readonly openCapture: (worktreeId: string) => Promise<CaptureSession>;
  readonly sdk: Sealant;
  readonly ownerId: string;
  readonly serviceKey: string;
  readonly deploymentId: string;
  readonly apiUrl: string;
  readonly worker: ManagedProcess;
  readonly api: ManagedProcess;
  /** Runs read-only SQL in Core's database and returns its rows as JSON values. */
  readonly query: (sql: string) => Promise<unknown[]>;
  /** SIGKILLs the worker: no finalizers run, as when a host dies. */
  readonly killWorker: () => Promise<void>;
  /** Core-labelled Docker objects (resources, gateways) created since the stack started. */
  /** Everything labelled with this run, Core's objects included (see `bin/docker`). */
  readonly ownedObjects: () => Promise<LabelledObjects>;
  /** Starts the worker, optionally with environment overrides (e.g. another gateway image). */
  readonly startWorker: (overrides?: Readonly<Record<string, string>>) => Promise<void>;
  /** The gateway image digest the worker was started with. */
  readonly gatewayImage: string;
  readonly stop: () => Promise<void>;
}

const run = promisify(execFile);

const sh = async (command: string, args: readonly string[], cwd = repo, env = process.env) => {
  try {
    return (await run(command, [...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr.slice(-3000)}`, {
      cause: error,
    });
  }
};

const freePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", listening);
  });
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  if (typeof address !== "object" || address === null) throw new Error("no free port");
  return address.port;
};

/** Starts a node process whose output goes to its log. */
const launchProcess = (
  process_: ManagedProcess,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => {
  const out = createWriteStream(process_.log, { flags: "a" });
  const child = spawn("node", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  process_.child = child;
  child.once("exit", (code, signal) => {
    out.write(`\n[boat-harness] ${process_.name} exited code=${code} signal=${signal}\n`);
    if (process_.child === child) process_.child = undefined;
  });
};
/** Signals a process, then kills it if it has not exited after 15 s. */
const stopProcess = async (process_: ManagedProcess, signal: NodeJS.Signals) => {
  const child = process_.child;
  if (child === undefined) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill(signal);
  await Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  process_.child = undefined;
};

/** Resolves once the process log matches `ready`; throws with the log tail if it has exited. */
const alive = async (process_: ManagedProcess, ready: RegExp) => {
  const text = await readFile(process_.log, "utf8").catch(() => "");
  if (process_.child === undefined)
    throw new Error(`${process_.name} exited at startup:\n${text.slice(-4000)}`);
  return ready.test(text) ? true : undefined;
};

const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}${last === undefined ? "" : `: ${String(last)}`}`,
      );
    await new Promise((done) => setTimeout(done, intervalMs));
  }
};

const ipv4 = (address: string) =>
  address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
const overlaps = (a: string, b: string) => {
  const [aBase = "", aBits = "32"] = a.split("/");
  const [bBase = "", bBits = "32"] = b.split("/");
  const bits = Math.min(Number(aBits), Number(bBits));
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (
    Math.floor(ipv4(aBase) / 2 ** (32 - bits)) * 2 ** (32 - bits) ===
      Math.floor(ipv4(bBase) / 2 ** (32 - bits)) * 2 ** (32 - bits) && mask >= 0
  );
};

/**
 * The twins' network. The guest's workspace namespace refuses private and special-purpose
 * destinations (`DENIED` in guest_network.py), and on Boat Mend's capture endpoint is public, so
 * the host side must sit on a publicly addressed bridge, as `network_proof.py` does. Docker's
 * default pools can also be exhausted on a busy host, so pick an unused /24 explicitly.
 */
const freeSubnet = async (): Promise<string> => {
  const ids = (await dockerOk(["network", "ls", "-q"])).split("\n").filter(Boolean);
  const used = (
    await dockerOk([
      "network",
      "inspect",
      "-f",
      "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
      ...ids,
    ])
  )
    .split(/\s+/)
    .filter((entry) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(entry));
  for (let third = 10; third < 250; third++) {
    const candidate = `192.0.${third}.0/24`;
    if (!used.some((entry) => overlaps(entry, candidate))) return candidate;
  }
  throw new Error("no free 192.0.x.0/24 subnet for the twin network");
};

/** Builds an image once per content hash of its context and returns its tag, kept between runs. */
const cachedImage = async (name: string, context: string, dockerfile?: string): Promise<string> => {
  const digest = createHash("sha256");
  for (const file of (await readdir(context)).toSorted())
    digest.update(file).update(await readFile(join(context, file)));
  const tag = `${name}:${digest.digest("hex").slice(0, 16)}`;
  const id = await docker(["image", "inspect", "-f", "{{.Id}}", tag]);
  if (id.code === 0 && process.env.BOAT_HARNESS_REBUILD !== "1") return tag;
  await dockerOk(
    [
      "build",
      "-q",
      // Not the run key: containers inherit image labels, and must not look like a run's.
      "--label",
      CACHE_LABEL,
      "-t",
      tag,
      ...(dockerfile === undefined ? [] : ["-f", dockerfile]),
      context,
    ],
    { timeoutMs: 20 * 60_000 },
  );
  return tag;
};

const makeTls = async (directory: string) => {
  const ca = join(directory, "ca.pem");
  const caKey = join(directory, "ca.key");
  const key = join(directory, "leaf.key");
  const csr = join(directory, "leaf.csr");
  const cert = join(directory, "leaf.pem");
  const ext = join(directory, "leaf.ext");
  await sh("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-days",
    "2",
    "-subj",
    "/CN=sealant boat harness CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  await sh("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=boat.dev",
  ]);
  await writeFile(
    ext,
    "subjectAltName=DNS:boat.dev,DNS:*.on.boat.dev\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
  );
  await sh("openssl", [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "2",
    "-extfile",
    ext,
  ]);
  return {
    ca,
    key: await readFile(key, "utf8"),
    cert: await readFile(cert, "utf8"),
  };
};

export interface StackOptions {
  readonly log?: (line: string) => void;
}

/**
 * Core's worker reconciles some Docker objects host-wide: resource reach networks
 * (`DockerResourceRuntime.converge`) and Boat gateways. On a shared Docker host it would treat
 * another deployment's objects as its own garbage. Refuse to start beside them.
 */
const preflight = async () => {
  if (process.env.BOAT_HARNESS_ALLOW_SHARED_DOCKER === "1") return;
  const foreign = await listCoreObjectNames();
  if (foreign.length > 0)
    throw new Error(
      `This Docker host already has Sealant resource or Boat gateway objects (${foreign.slice(0, 5).join(", ")}). ` +
        "Core's worker reconciles those host-wide, so the harness will not run beside them. " +
        "Stop that deployment, or set BOAT_HARNESS_ALLOW_SHARED_DOCKER=1 to accept the risk.",
    );
};

export const startStack = async (options: StackOptions = {}): Promise<HarnessStack> => {
  const log = options.log ?? ((line: string) => process.stderr.write(`[boat-harness] ${line}\n`));
  const runId = randomBytes(4).toString("hex");
  await acquireHostLock(runId, process.pid, log);
  try {
    await preflight();
  } catch (error) {
    await releaseLock(runId);
    throw error;
  }
  const label = `${HARNESS_LABEL}=${runId}`;
  const scratch = await mkdtemp(join(tmpdir(), `boat-harness-${runId}.`));
  log(`run ${runId}, scratch ${scratch}`);
  // A detached reaper outlives a Ctrl-C or a killed test process and removes what the run left.
  const reaperLog = await open(join(scratch, "reaper.log"), "a");
  const reaper = spawn(
    "node",
    ["--import", "tsx", join(here, "reaper.ts"), runId, String(process.pid)],
    {
      cwd: join(repo, "packages/workspaces"),
      detached: true,
      stdio: ["ignore", reaperLog.fd, reaperLog.fd],
    },
  );
  reaper.unref();
  await reaperLog.close();
  // Runs last at teardown, after everything else is gone.
  const cleanups: Array<() => Promise<unknown>> = [
    () => releaseLock(runId),
    async () => {
      reaper.kill("SIGTERM");
    },
  ];
  try {
    // Images: guest twin base and the real resource gateway.
    log("building guest twin and gateway images (cached by tag)");
    const [twinImage, gatewayBase] = await Promise.all([
      cachedImage("sealant-boat-harness-twin", join(here, "twin")),
      cachedImage("sealant-boat-harness-gateway", join(repo, "packages/workspaces/boat-tunnel")),
    ]);
    // Core wants the gateway by digest. Its containers get this run's label from `bin/docker`.
    const gatewayImage = (
      await dockerOk(["image", "inspect", "-f", "{{.Id}}", gatewayBase])
    ).trim();

    // The twins' network. The host is its gateway address: twins reach the published WireGuard port
    // and the capture channel there, and the host reaches each twin by its address.
    const network = `boat-harness-${runId}`;
    // Name each bridge's host address explicitly: some Docker versions leave it out of `inspect`.
    const bridge = async (name: string) => {
      const range = await freeSubnet();
      const host = range.replace(/\.0\/24$/, ".1");
      await dockerOk([
        "network",
        "create",
        "--subnet",
        range,
        "--gateway",
        host,
        "--label",
        label,
        name,
      ]);
      return { range, host };
    };
    const { range: subnet, host: hostIp } = await bridge(network);
    // Runs after the worker and API stop. Core's objects carry the label too (`bin/docker`).
    cleanups.push(() => removeLabelled(label, { images: true }));
    // The guest refuses workspace egress to the WireGuard endpoint's address, and on Boat the
    // gateway host and Mend's capture endpoint are different addresses. Give the gateway endpoint a
    // host address of its own: the gateway IP of an otherwise unused bridge. Twins reach it through
    // the host; the gateway publishes its UDP port on every host address.
    const edge = `${network}-edge`;
    const { host: gatewayEndpoint } = await bridge(edge);

    // Core's database.
    const dbPort = await freePort();
    await dockerOk([
      "run",
      "-d",
      "--name",
      `boat-harness-${runId}-postgres`,
      "--label",
      label,
      "-e",
      "POSTGRES_PASSWORD=sealant",
      "-e",
      "POSTGRES_USER=sealant",
      "-e",
      "POSTGRES_DB=sealant_control_plane",
      "-p",
      `127.0.0.1:${dbPort}:5432`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:17-alpine",
    ]);
    const databaseUrl = `postgresql://sealant:sealant@127.0.0.1:${dbPort}/sealant_control_plane`;
    const psql = (sql: string) =>
      dockerOk([
        "exec",
        `boat-harness-${runId}-postgres`,
        "psql",
        "-U",
        "sealant",
        "-d",
        "sealant_control_plane",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        sql,
      ]);
    const query = async (sql: string): Promise<unknown[]> => {
      const out = (await psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`)).trim();
      const rows: unknown = JSON.parse(out);
      return Array.isArray(rows) ? rows : [];
    };
    await waitFor(
      "postgres",
      async () => ((await psql("select 1")).trim() === "1" ? true : undefined),
      60_000,
    );
    log("migrating");
    await sh("pnpm", ["--filter", "@sealant/db", "db:migrate"], repo, {
      ...process.env,
      DATABASE_URL: databaseUrl,
    });
    const ownerId = `boat-harness-owner-${runId}`;
    await psql(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('${ownerId}', 'Boat Harness', '${ownerId}@harness.invalid', true, now(), now())`,
    );

    // TLS for the fake `boat.dev` and `*.on.boat.dev`.
    const tlsDir = join(scratch, "tls");
    await mkdir(tlsDir, { mode: 0o700 });
    const tls = await makeTls(tlsDir);

    const credential = `harness-${randomBytes(16).toString("hex")}`;
    const boat = new FakeBoat({
      runId,
      credential,
      network,
      baseImage: twinImage,
      tls: { key: tls.key, cert: tls.cert },
    });
    await boat.start();
    cleanups.push(() => boat.stop());
    log(`fake Boat API ${boat.baseUrl}, TLS front 127.0.0.1:${boat.proxyPort}`);

    // One container per capture session on the twins' network (see capture-server.ts).
    const network24 = subnet.split(".").slice(0, 3).join(".");
    let nextCaptureHost = 200;
    // The Docker daemon may not see the checkout (e.g. ProtectHome), so ship a bundle instead.
    const captureBundle = join(scratch, "capture-server.mjs");
    await sh("node", [
      "-e",
      `import("esbuild").then((esbuild) => esbuild.build({ entryPoints: [${JSON.stringify(join(here, "capture-server.ts"))}], bundle: true, platform: "node", format: "esm", target: "node22", outfile: ${JSON.stringify(captureBundle)} }))`,
    ]);
    const captureSchema = z.object({
      endpoint: z.string(),
      head: z.object({ n: z.number(), capture_id: z.string() }).nullable(),
      planRequests: z.number(),
      objects: z.number(),
      errors: z.array(z.string()),
    });
    const openCapture = async (worktreeId: string): Promise<CaptureSession> => {
      const token = randomBytes(24).toString("hex");
      const ip = `${network24}.${nextCaptureHost++}`;
      const container = `boat-harness-${runId}-capture-${worktreeId}`;
      await dockerOk([
        "create",
        "--name",
        container,
        "--label",
        label,
        "--network",
        network,
        "--ip",
        ip,
        "-e",
        `CAPTURE_TOKEN=${token}`,
        "-e",
        `CAPTURE_WORKTREE_ID=${worktreeId}`,
        "-e",
        `CAPTURE_ADVERTISE_HOST=${ip}`,
        "node:24-bookworm-slim",
        "node",
        "/capture-server.mjs",
      ]);
      await dockerOk(["cp", captureBundle, `${container}:/capture-server.mjs`]);
      await dockerOk(["start", container]);
      const state = async () =>
        captureSchema.parse(await (await fetch(`http://${ip}:9000/harness/state`)).json());
      const endpoint = await waitFor(
        "the capture channel",
        async () => (await state()).endpoint,
        60_000,
      );
      return { endpoint, token, worktreeId, state };
    };

    // The production worker bundle with its packaged Boat assets beside it.
    log("bundling worker and staging Boat assets");
    await sh("pnpm", ["--filter", "@sealant/worker", "build"]);
    const workerDir = join(scratch, "worker");
    await mkdir(join(workerDir, "dist"), { recursive: true });
    await copyFile(join(repo, "apps/worker/dist/index.js"), join(workerDir, "dist/index.js"));
    await symlink(join(repo, "apps/worker/node_modules"), join(workerDir, "node_modules"));
    await sh("node", [
      join(repo, "packages/workspaces/boat-image/stage-assets.mjs"),
      join(workerDir, "boat-assets"),
    ]);
    // Teardown keeps only the logs: it removes exactly the directories this run made.
    cleanups.push(async () => {
      for (const name of ["worker", "boat-state", "tmp", "tls"])
        await rm(join(scratch, name), { recursive: true, force: true });
    });
    const stateDir = join(scratch, "boat-state");
    await mkdir(stateDir, { mode: 0o700 });
    // The worker sweeps stale `sealant-buildkit-*` directories from its temp dir. Give it its own.
    const processTmp = join(scratch, "tmp");
    await mkdir(processTmp, { mode: 0o700 });

    const realDocker = (await sh("sh", ["-c", "command -v docker"])).trim();
    if (!realDocker.startsWith("/")) throw new Error("docker is not on PATH");
    const credentialsKey = randomBytes(32).toString("base64");
    const serviceKey = `slt_harness_${randomBytes(16).toString("hex")}`;
    const deploymentId = `harness-${runId}`;
    const apiPort = await freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const octet = 100 + (Number.parseInt(runId.slice(0, 2), 16) % 100);
    const shared = {
      ...process.env,
      NODE_ENV: "development",
      TMPDIR: processTmp,
      DATABASE_URL: databaseUrl,
      SEALANT_CREDENTIALS_KEY: credentialsKey,
      SEALANT_BOAT_ADMISSION_OWNER_IDS: ownerId,
      DEFAULT_RUNTIME_ADAPTER: "docker",
      SEALANT_RESOURCE_REACH_SUBNETS: `10.${octet}.0.0/16`,
      SEALANT_RESOURCE_EGRESS_SUBNETS: `10.${octet + 1}.0.0/16`,
      SEALANT_RESOURCE_TICK_MS: "2000",
      SEALANT_BOAT_HARNESS_PORT: String(boat.proxyPort),
      [RUN_ENV]: runId,
      // Core runs the docker CLI from PATH; the wrapper labels what it creates with this run.
      PATH: `${join(here, "bin")}:${process.env.PATH ?? ""}`,
      SEALANT_BOAT_HARNESS_REAL_DOCKER: realDocker,
      NODE_EXTRA_CA_CERTS: tls.ca,
      NODE_OPTIONS: `--import ${join(here, "preload.mjs")}`,
    };
    const workerEnv = {
      ...shared,
      DOCKER_RUNTIME_ENABLED: "true",
      SEALANT_BOAT_API_KEY: credential,
      SEALANT_BOAT_DEPLOYMENT_ID: deploymentId,
      SEALANT_BOAT_GATEWAY_HOST_ID: randomUUID(),
      SEALANT_BOAT_GATEWAY_ENDPOINT: gatewayEndpoint,
      SEALANT_BOAT_GATEWAY_IMAGE: gatewayImage,
      SEALANT_BOAT_BUILDER_OWNER: randomUUID(),
      SEALANT_BOAT_STATE_DIRECTORY: stateDir,
      SEALANT_BOAT_AUTOMATIC_PARKING: "false",
    };
    const apiEnv = {
      ...shared,
      PORT: String(apiPort),
      SEALANT_SERVICE_KEYS: serviceKey,
    };

    const managed = (name: string): ManagedProcess => ({
      name,
      log: join(scratch, `${name}.log`),
      child: undefined,
    });
    const worker = managed("worker");
    const api = managed("api");
    const startWorker = async (overrides: Readonly<Record<string, string>> = {}) => {
      launchProcess(worker, ["--enable-source-maps", join(workerDir, "dist/index.js")], workerDir, {
        ...workerEnv,
        ...overrides,
      });
    };
    cleanups.push(() => stopProcess(worker, "SIGTERM"));
    cleanups.push(() => stopProcess(api, "SIGTERM"));

    log("starting API and worker");
    launchProcess(api, ["--import", "tsx", "src/index.ts"], join(repo, "apps/api"), apiEnv);
    await startWorker();
    // A process that dies at startup (e.g. a refused config) would otherwise leave every scenario
    // waiting on a launch nobody runs. Fail the stack with the log tail instead.
    await waitFor("the worker to start", () => alive(worker, /Sealant worker starting/), 120_000);
    await waitFor(
      "API",
      async () => {
        if (api.child === undefined) await alive(api, /$^/);
        const response = await fetch(`${apiUrl}/healthz`).catch(() => undefined);
        return response !== undefined && response.status < 500 ? true : undefined;
      },
      120_000,
    );
    const sdk = new Sealant({ baseUrl: apiUrl, apiKey: serviceKey });
    cleanups.push(() => sdk.close());

    // Runs first at teardown: keep the evidence a failure needs before anything is removed.
    cleanups.push(async () => {
      await writeFile(join(scratch, "boat-events.json"), JSON.stringify(boat.events, null, 1));
      const rows: Record<string, unknown> = {};
      for (const table of [
        "workspace_runtime_instances",
        "boat_allocations",
        "boat_executions",
        "boat_tunnels",
        "native_publication_consumers",
        "workspace_capture_drains",
        "native_publications",
      ])
        rows[table] = await query(`select * from ${table}`).catch((error: unknown) =>
          String(error),
        );
      await writeFile(join(scratch, "core-rows.json"), JSON.stringify(rows, null, 1));
      for (const sandbox of boat.liveSandboxes()) {
        // The agent's unit (sealantd's output is in it), then the guest dockerd's own log.
        const journal = await docker(
          [
            "exec",
            sandbox.container,
            "/bin/sh",
            "-c",
            "journalctl --no-pager -o short-iso -u 'sealant*'; echo; echo '--- /run/sealant/dockerd.stderr.log'; cat /run/sealant/dockerd.stderr.log 2>/dev/null",
          ],
          { timeoutMs: 30_000 },
        );
        await writeFile(join(scratch, `guest-${sandbox.id}.log`), journal.stdout + journal.stderr);
      }
    });
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= (async () => {
        for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => undefined);
        log(`stopped; logs in ${scratch}`);
      })());
    // An interrupted run still tears down what it made.
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void stop().finally(() => process.exit(130));
      });
    return {
      runId,
      scratch,
      network,
      hostIp,
      gatewayEndpoint,
      databaseUrl,
      boat,
      openCapture,
      sdk,
      ownerId,
      serviceKey,
      deploymentId,
      apiUrl,
      worker,
      api,
      query,
      killWorker: () => stopProcess(worker, "SIGKILL"),
      ownedObjects: () => listLabelled(label),
      startWorker,
      gatewayImage,
      stop,
    };
  } catch (error) {
    for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => undefined);
    throw error;
  }
};
