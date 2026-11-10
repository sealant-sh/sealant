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
import { RUN_ENV, acquireHostLock, keepLock, listRuns, releaseLock } from "./reap.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../..");

export interface CaptureState {
  readonly endpoint: string;
  readonly head: { readonly n: number; readonly capture_id: string } | null;
  readonly planRequests: number;
  readonly objects: number;
  readonly errors: readonly string[];
  /** Every answered `capture.register`, in order (see capture-server.ts). */
  readonly registers: readonly CaptureRegister[];
}

export interface CaptureRegister {
  /** When the channel answered it, in ms since the epoch (same clock as the fake Boat's events). */
  readonly at: number;
  readonly n: number | null;
  /** The register carried a complete FINAL seal. */
  readonly final: boolean;
  readonly sealRecorded: boolean;
}

/**
 * Core's database refused a harness query (e.g. a table or column a change dropped). Waits fail at
 * once on it rather than retrying until their timeout.
 */
export class QueryError extends Error {
  override readonly name = "QueryError";
}

/** Worker environment overrides; `undefined` removes a variable. */
export type WorkerOverrides = Readonly<Record<string, string | undefined>>;

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
  readonly startWorker: (overrides?: WorkerOverrides) => Promise<void>;
  /** Stops the worker as a deploy would (SIGTERM), then starts it with these overrides. */
  readonly restartWorker: (overrides?: WorkerOverrides) => Promise<void>;
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

/**
 * Builds an image once per content hash of its context and returns its tag, kept between runs.
 * Build arguments change only how an image is built (where it downloads from), never what it holds,
 * so they are not part of the tag: a cached image is used whatever they are.
 */
const cachedImage = async (
  name: string,
  context: string,
  options: { readonly dockerfile?: string; readonly args?: Readonly<Record<string, string>> } = {},
): Promise<string> => {
  const digest = createHash("sha256");
  for (const file of (await readdir(context)).toSorted())
    digest.update(file).update(await readFile(join(context, file)));
  const args = Object.entries(options.args ?? {});
  const tag = `${name}:${digest.digest("hex").slice(0, 16)}`;
  const id = await docker(["image", "inspect", "-f", "{{.Id}}", tag]);
  if (id.code === 0 && process.env.BOAT_HARNESS_REBUILD !== "1") return tag;
  const built = await docker(
    [
      "build",
      "--progress=plain",
      // Not the run key: containers inherit image labels, and must not look like a run's.
      "--label",
      CACHE_LABEL,
      "-t",
      tag,
      ...(options.dockerfile === undefined ? [] : ["-f", options.dockerfile]),
      ...args.flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
      context,
    ],
    { timeoutMs: 20 * 60_000 },
  );
  if (built.code !== 0) {
    // apt's own lines say which host failed; the build's last lines only echo the Dockerfile.
    const apt = `${built.stdout}\n${built.stderr}`
      .split("\n")
      .filter((line) => /\b(E:|W: Failed|Err:)/.test(line))
      .slice(-12);
    throw new Error(
      `building ${tag} failed (${String(built.code)}${built.timedOut ? ", timed out" : ""}): ${apt.join(" | ") || built.stderr.slice(-1500)}`,
    );
  }
  return tag;
};

/**
 * Where the twins read Ubuntu 24.04: the stock archive, else a full mirror of it, as
 * `recipe.e2e.ts` does (#534). The native build runs apt in a twin, so an archive outage would
 * otherwise fail every scenario and say nothing about Boat. Both unreachable fails the stack at once.
 */
const STOCK_ARCHIVE = "http://archive.ubuntu.com/ubuntu";
const UBUNTU_ARCHIVES = [STOCK_ARCHIVE, "http://mirrors.edge.kernel.org/ubuntu"] as const;

/**
 * The twin image reading Ubuntu from `mirror` instead of the stock archive and security host: one
 * layer over the cached twin that rewrites apt's sources, built without any download.
 */
const mirroredTwin = async (twin: string, mirror: string): Promise<string> => {
  const tag = `${twin}-mirror`;
  if ((await docker(["image", "inspect", "-f", "{{.Id}}", tag])).code === 0) return tag;
  await dockerOk(["build", "-q", "--label", CACHE_LABEL, "-t", tag, "-"], {
    input: [
      `FROM ${twin}`,
      `RUN sed -i -e "s|http://archive.ubuntu.com/ubuntu|${mirror}|g" -e "s|http://security.ubuntu.com/ubuntu|${mirror}|g" /etc/apt/sources.list.d/ubuntu.sources`,
    ].join("\n"),
    timeoutMs: 5 * 60_000,
  });
  return tag;
};

const reachableArchive = async (log: (line: string) => void): Promise<string> => {
  const failures: string[] = [];
  for (const url of UBUNTU_ARCHIVES) {
    const answer = await fetch(`${url}/dists/noble/Release`, {
      method: "HEAD",
      signal: AbortSignal.timeout(20_000),
    }).catch((error: unknown) => error);
    if (answer instanceof Response && answer.ok) {
      if (url !== STOCK_ARCHIVE)
        log(`Ubuntu archive unreachable (${failures.join("; ")}); twins read ${url}`);
      return url;
    }
    failures.push(
      `${url}: ${answer instanceof Response ? `HTTP ${answer.status}` : String(answer)}`,
    );
  }
  throw new Error(
    `Ubuntu's archive and its mirror are both unreachable (${failures.join("; ")}): the native build cannot run, so no scenario could say anything about Boat`,
  );
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
const preflight = async (runId: string) => {
  // Another run's objects without its lock: that run lost the lock, or died before its teardown.
  const others = (await listRuns()).filter((other) => other !== runId);
  if (others.length > 0)
    throw new Error(
      `Harness runs ${others.join(", ")} still have labelled objects on this Docker host. ` +
        "List and remove them with `pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts [--remove]`.",
    );
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
  const lockId = await acquireHostLock(runId, log);
  const stopRenewing = keepLock(lockId, () =>
    log(`run ${runId} lost the host lock: its heartbeat could not be renewed`),
  );
  try {
    await preflight(runId);
  } catch (error) {
    stopRenewing();
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
    ["--import", "tsx", join(here, "reaper.ts"), runId, String(process.pid), lockId],
    {
      cwd: join(repo, "packages/workspaces"),
      // Carrying the run lets a later reap find it.
      env: { ...process.env, [RUN_ENV]: runId },
      detached: true,
      stdio: ["ignore", reaperLog.fd, reaperLog.fd],
    },
  );
  reaper.unref();
  await reaperLog.close();
  // Runs last at teardown, after everything else is gone.
  const cleanups: Array<() => Promise<unknown>> = [
    async () => {
      stopRenewing();
      await releaseLock(runId);
    },
    async () => {
      reaper.kill("SIGTERM");
    },
  ];
  try {
    // Images: guest twin base and the real resource gateway.
    log("building guest twin and gateway images (cached by tag)");
    // The local pin (`BOAT_HARNESS_UBUNTU_ARCHIVE_IP`) keeps the stock archive's name, so it needs
    // no mirror.
    const archive =
      process.env.BOAT_HARNESS_UBUNTU_ARCHIVE_IP === undefined
        ? await reachableArchive(log)
        : STOCK_ARCHIVE;
    const [twinBase, gatewayBase] = await Promise.all([
      cachedImage("sealant-boat-harness-twin", join(here, "twin"), {
        args: archive === STOCK_ARCHIVE ? {} : { UBUNTU_ARCHIVE: archive },
      }),
      cachedImage("sealant-boat-harness-gateway", join(repo, "packages/workspaces/boat-tunnel")),
    ]);
    // The base ends on the stock archive, as a Boat VM does; when only the mirror answers, the
    // twins (and the native build in them) read the mirror instead.
    const twinImage = archive === STOCK_ARCHIVE ? twinBase : await mirroredTwin(twinBase, archive);
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
      const out = (
        await psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`).catch(
          (error: unknown) => {
            throw new QueryError(error instanceof Error ? error.message : String(error));
          },
        )
      ).trim();
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
      // Opt-in, local only: pin archive.ubuntu.com when the address DNS returns is unreachable
      // from this network. It changes what the guest resolves, so it does not represent Boat.
      ...(process.env.BOAT_HARNESS_UBUNTU_ARCHIVE_IP === undefined
        ? {}
        : {
            extraHosts: ["archive.ubuntu.com", "security.ubuntu.com"].map(
              (name) => `${name}:${process.env.BOAT_HARNESS_UBUNTU_ARCHIVE_IP}`,
            ),
          }),
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
      registers: z.array(
        z.object({
          at: z.number(),
          n: z.number().nullable(),
          final: z.boolean(),
          sealRecorded: z.boolean(),
        }),
      ),
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
      // Both the worker and the API hold the Boat key and deployment (the API needs them once it
      // talks to Boat itself, #563; on main it ignores them).
      SEALANT_BOAT_API_KEY: credential,
      SEALANT_BOAT_DEPLOYMENT_ID: deploymentId,
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
      SEALANT_BOAT_GATEWAY_HOST_ID: randomUUID(),
      // The production shape for a deployment with no inbound UDP path (#540, #542, #543): the
      // worker carries each tunnel over the agent's WebSocket through the hosted proxy, to the
      // gateway port published on this address. No guest dials the gateway.
      SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
      SEALANT_BOAT_GATEWAY_IMAGE: gatewayImage,
      SEALANT_BOAT_BUILDER_OWNER: randomUUID(),
      SEALANT_BOAT_STATE_DIRECTORY: stateDir,
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
    const startWorker = async (overrides: WorkerOverrides = {}) => {
      const env: NodeJS.ProcessEnv = { ...workerEnv };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      launchProcess(
        worker,
        ["--enable-source-maps", join(workerDir, "dist/index.js")],
        workerDir,
        env,
      );
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
    // An interrupted run still tears down what it made, and releases the host lock promptly.
    const interrupted = () => {
      // After a normal teardown (afterAll) there is nothing left to do, and vitest ends the fork.
      if (stopping !== undefined) return;
      void stop().finally(() => process.exit(130));
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, interrupted);
    // Ctrl-C to vitest kills its main process but not this test fork, which would otherwise keep
    // running scenarios and holding the lock. Treat losing the parent as an interrupt: the IPC
    // channel to it closes, or the fork is re-parented.
    process.once("disconnect", interrupted);
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) interrupted();
    }, 2000).unref();
    return {
      runId,
      scratch,
      network,
      hostIp,
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
      restartWorker: async (overrides = {}) => {
        await stopProcess(worker, "SIGTERM");
        await startWorker(overrides);
        await waitFor(
          "the worker to restart",
          async () => (worker.child === undefined ? undefined : true),
          30_000,
        );
      },
      gatewayImage,
      stop,
    };
  } catch (error) {
    for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => undefined);
    throw error;
  }
};
