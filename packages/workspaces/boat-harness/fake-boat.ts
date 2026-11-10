import { spawn, type ChildProcess } from "node:child_process";
/**
 * A local Boat provider. It speaks Boat's HTTP API on 127.0.0.1 (which `HttpBoatApi.create` already
 * accepts) and replays Boat's recorded state machine, while every VM is a real guest-twin container:
 *
 * - create answers 202 `provisioned`, then `cloning`, then `idle` once systemd has booted
 *   (docs/experiments/boat-provider-lifetime-evidence.json, 2026-11-05);
 * - commands run for real in the guest as uid 1000 (docs/experiments/boat-runtime.md), sync up to
 *   30 s and detached with process polling above that;
 * - DELETE requires `X-Ascii-Confirm-Delete` and returns a deletion operation to poll;
 * - saved snapshots are `docker commit`, and creating `from` one boots a new container with a new
 *   boot ID;
 * - the hosted port proxy for `*.on.boat.dev` checks `_port_auth`, answers 403 without it and 302 for
 *   `_token` (both recorded in boat-runtime.md), and forwards HTTP and WebSocket to the guest's 8080.
 *
 * Faults are injected through `faults`, never by changing Core.
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { z } from "zod";

import { HARNESS_LABEL, docker, okWith, type DockerRunner } from "./docker.js";

export type SandboxState =
  | "provisioned"
  | "cloning"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

export interface FakeSandbox {
  readonly id: string;
  readonly labels: Record<string, string>;
  readonly ttlSeconds: number | null;
  readonly snapshots: boolean;
  readonly monitoring: boolean;
  readonly container: string;
  readonly image: string;
  readonly createdAt: string;
  readonly hostToken: string;
  state: SandboxState;
  hydrated: boolean | undefined;
  stoppedAt: string | null;
  ip: string | undefined;
  deletion: FakeDeletion | undefined;
  removed: boolean;
  /** The saved snapshot's copy of `/var/lib/sealant/docker` this VM starts from, if any. */
  readonly dockerSeed: string | undefined;
}

export interface FakeDeletion {
  readonly id: string;
  readonly targetId: string;
  status: "pending" | "processing" | "blocked" | "completed";
}

export interface FakeSnapshot {
  readonly name: string;
  readonly sourceSandboxId: string;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly image: string;
  /** The volume holding the source's `/var/lib/sealant/docker`: Boat saves the whole disk. */
  readonly dockerData: string;
  status: "saving" | "ready" | "failed";
}

export interface SnapshotView {
  readonly name: string;
  readonly status: FakeSnapshot["status"];
  readonly sourceSandboxId: string;
  readonly snapshotId: string;
  readonly createdAt: string;
}

export type CommandFault =
  | { readonly kind: "exit"; readonly code: number; readonly stderr?: string }
  | { readonly kind: "timeout" }
  /** The provider loses the HTTP reply after the command has run for `afterMs`. */
  | { readonly kind: "drop"; readonly afterMs: number }
  /** The command starts `ms` late, as on a slow or busy VM. */
  | { readonly kind: "delay"; readonly ms: number };

export type ProxyFault =
  | { readonly kind: "status"; readonly status: number; readonly body: string }
  | { readonly kind: "destroy" };

/** Every hook is optional. A hook returning `undefined` means "behave like Boat". */
export interface FakeBoatFaults {
  /** `lose-reply` creates the VM, then drops the HTTP reply. `stuck` never leaves `provisioned`. */
  create?: (body: Record<string, unknown>) => "lose-reply" | "stuck" | undefined;
  command?: (command: string, sandbox: FakeSandbox) => CommandFault | undefined;
  /** Runs before a command reaches the guest, e.g. to change the guest just before bind. */
  beforeCommand?: (command: string, sandbox: FakeSandbox) => Promise<void>;
  /** Runs after a command finished in the guest and before Core can observe that it finished. */
  afterCommand?: (command: string, sandbox: FakeSandbox) => Promise<void>;
  proxy?: (path: string, method: string, sandbox: FakeSandbox) => ProxyFault | undefined;
  /** Runs before the hosted proxy forwards a request, e.g. to break the host side first. */
  beforeProxy?: (path: string, method: string, sandbox: FakeSandbox) => Promise<void>;
  deletion?: (sandbox: FakeSandbox) => "stuck" | undefined;
  snapshot?: (name: string) => "failed" | undefined;
}

export interface FakeBoatEvent {
  readonly at: number;
  readonly kind: string;
  readonly sandboxId?: string;
  readonly detail?: string;
}

export interface FakeBoatOptions {
  readonly runId: string;
  readonly credential: string;
  /** Docker network the twins join. The host reaches them by IP; they reach the host gateway. */
  readonly network: string;
  /** The guest-twin base image a create without `from` boots. */
  readonly baseImage: string;
  /** The hosted proxy's TLS front. Without it only the plain API listens (unit tests). */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Status the hosted proxy answers when nothing listens on the guest port. Not recorded; see README. */
  readonly closedPortStatus?: number;
  readonly pageSize?: number;
  /** The fake's clock (idempotency retention). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** A trial account: Boat refuses saved snapshots with 403 (boat-runtime.md). */
  readonly trialAccount?: boolean;
  /** The docker CLI, for tests. */
  readonly docker?: DockerRunner;
  /** `host:ip` entries for every twin's /etc/hosts (an opt-in workaround; see README). */
  readonly extraHosts?: readonly string[];
}

/** Boat keeps an idempotency key for 24 hours (docs/experiments/boat-provider-lifetime.md). */
const KEY_RETENTION_MS = 24 * 60 * 60_000;

const OUTPUT_LIMIT = 8 * 1024 ** 2;
const VERBOSE = process.env.BOAT_HARNESS_VERBOSE === "1";
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const newSandboxId = () =>
  "bx_" + [...randomBytes(8)].map((byte) => ALPHABET[byte % ALPHABET.length] ?? "2").join("");
const now = () => new Date().toISOString();
const tail = (text: string) =>
  Buffer.byteLength(text) <= OUTPUT_LIMIT ? text : text.slice(text.length - OUTPUT_LIMIT);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

const createBody = z
  .object({
    type: z.literal("small"),
    ttlSeconds: z.number().int().positive().nullable(),
    noEnv: z.literal(true),
    monitoring: z.boolean(),
    snapshots: z.boolean().optional(),
    visibility: z.literal("private").optional(),
    // Boat's label limits: at most 20, each value at most 256 bytes.
    labels: z
      .record(z.string(), z.string())
      .refine((labels) => Object.keys(labels).length <= 20, "too many labels")
      .refine(
        (labels) => Object.values(labels).every((value) => Buffer.byteLength(value) <= 256),
        "label value too long",
      ),
    from: z.string().optional(),
  })
  .strict();
const resumeBody = z
  .object({
    type: z.literal("small"),
    ttlSeconds: z.number().int().positive().nullable(),
    noEnv: z.literal(true),
    monitoring: z.boolean().optional(),
    snapshots: z.boolean().optional(),
  })
  .strict();
const commandBody = z
  .object({
    command: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).max(600),
    detached: z.literal(true).optional(),
  })
  .strict();
const fileBody = z
  .object({
    path: z.string(),
    content: z.string(),
    encoding: z.literal("utf8"),
  })
  .strict();
const uploadBody = z.object({ path: z.string(), ttlSeconds: z.number().int() }).strict();
const hostBody = z
  .object({
    port: z.number().int(),
    public: z.boolean(),
    localhost: z.boolean(),
  })
  .strict();
const snapshotBody = z
  .object({
    sandboxId: z.string(),
    name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  })
  .strict();

interface DetachedProcess {
  readonly id: number;
  readonly sandboxId: string;
  readonly child: ChildProcess;
  readonly pidFile: string;
  stdout: string;
  stderr: string;
  /** Output beyond 8 MiB was dropped from the front; Boat reports that. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  running: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class FakeBoat {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly snapshots = new Map<string, FakeSnapshot>();
  readonly deletions = new Map<string, FakeDeletion>();
  readonly events: FakeBoatEvent[] = [];
  faults: FakeBoatFaults = {};
  readonly #idempotency = new Map<
    string,
    { readonly body: string; readonly id: string; readonly acceptedAt: number }
  >();
  readonly #docker: DockerRunner;
  readonly #dockerOk: ReturnType<typeof okWith>;
  readonly #clock: () => number;
  readonly #processes = new Map<number, DetachedProcess>();
  readonly #uploads = new Map<
    string,
    {
      readonly sandboxId: string;
      readonly path: string;
      readonly expires: number;
    }
  >();
  #nextProcess = 1;
  #api: http.Server | undefined;
  #proxy: https.Server | undefined;
  readonly #background = new Set<Promise<unknown>>();

  constructor(readonly options: FakeBoatOptions) {
    this.#docker = options.docker ?? docker;
    this.#dockerOk = okWith(this.#docker);
    this.#clock = options.clock ?? Date.now;
  }

  get apiPort(): number {
    const address = this.#api?.address();
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("fake Boat API is not listening");
    return address.port;
  }

  get proxyPort(): number {
    const address = this.#proxy?.address();
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("fake Boat proxy is not listening");
    return address.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.apiPort}/api/v1`;
  }

  async start(): Promise<void> {
    this.#api = http.createServer((request, response) => {
      void this.#serveApi(request, response);
    });
    const tls = this.options.tls;
    if (tls !== undefined) {
      const proxy = https.createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
        void this.#serveProxy(request, response);
      });
      proxy.on("upgrade", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        this.#upgrade(request, socket, head);
      });
      this.#proxy = proxy;
    }
    await Promise.all([
      new Promise<void>((done) => this.#api?.listen(0, "127.0.0.1", done)),
      new Promise<void>((done) =>
        this.#proxy === undefined ? done() : this.#proxy.listen(0, "127.0.0.1", done),
      ),
    ]);
  }

  async stop(): Promise<void> {
    for (const process of this.#processes.values()) process.child.kill("SIGKILL");
    await Promise.allSettled(this.#background);
    this.#api?.closeAllConnections();
    this.#proxy?.closeAllConnections();
    await Promise.all([
      new Promise<void>((done) =>
        this.#api === undefined ? done() : this.#api.close(() => done()),
      ),
      new Promise<void>((done) =>
        this.#proxy === undefined ? done() : this.#proxy.close(() => done()),
      ),
    ]);
  }

  /** Live (not completed-deleted) sandboxes, as an inventory would list them. */
  liveSandboxes(): FakeSandbox[] {
    return [...this.sandboxes.values()].filter((sandbox) => !sandbox.removed);
  }

  /** Runs a root command in a twin, outside Boat's API, for scenario setup and fault injection. */
  async guestRoot(id: string, script: string): Promise<string> {
    const sandbox = this.#sandbox(id);
    return this.#dockerOk(["exec", sandbox.container, "/bin/bash", "-ceu", script], {
      timeoutMs: 60_000,
    });
  }

  #record(kind: string, sandboxId?: string, detail?: string) {
    // CI has no other window into a run that hangs: stream the lifecycle, not every API call.
    if (VERBOSE && kind !== "api" && !(kind === "proxy" && (detail ?? "").endsWith(" 200")))
      process.stderr.write(
        `[boat-harness] boat ${new Date().toISOString()} ${kind} ${sandboxId ?? ""} ${(detail ?? "").slice(0, 200)}\n`,
      );
    this.events.push({
      at: Date.now(),
      kind,
      ...(sandboxId === undefined ? {} : { sandboxId }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  #track(work: Promise<unknown>) {
    const tracked = work.catch((error: unknown) => {
      this.#record("background-error", undefined, String(error));
    });
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }

  #sandbox(id: string): FakeSandbox {
    const sandbox = this.sandboxes.get(id);
    if (sandbox === undefined || sandbox.removed) throw new HttpError(404, "sandbox_not_found");
    return sandbox;
  }

  #view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      state: sandbox.state,
      labels: sandbox.labels,
      archiveAfter: sandbox.ttlSeconds === null ? null : now(),
      ttlSeconds: sandbox.ttlSeconds,
      snapshots: sandbox.snapshots,
      monitoring: sandbox.monitoring,
      dataExpiredAt: null,
      stoppedAt: sandbox.stoppedAt,
      // Core's parking reads the stop operation's status before it saves a snapshot.
      stop:
        sandbox.state === "archiving"
          ? { status: "pending" }
          : sandbox.stoppedAt === null
            ? null
            : { status: "completed" },
      ...(sandbox.hydrated === undefined ? {} : { hydrated: sandbox.hydrated }),
    };
  }

  #snapshotView(snapshot: FakeSnapshot): SnapshotView {
    return {
      name: snapshot.name,
      status: snapshot.status,
      sourceSandboxId: snapshot.sourceSandboxId,
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
    };
  }

  async #serveApi(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.authorization !== `Bearer ${this.options.credential}`)
        throw new HttpError(401, "unauthorized");
      const raw = await readBody(request);
      const json = (): unknown => (raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8")));
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const method = request.method ?? "GET";
      this.#record("api", undefined, `${method} ${path}`);
      let match: RegExpMatchArray | null;
      if (method === "POST" && path === "/sandboxes") {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new HttpError(400, "idempotency_key_required");
        const body = createBody.parse(json());
        const kept = this.#idempotency.get(key);
        // After 24 hours Boat forgets the key; a replay then creates another VM.
        const previous =
          kept !== undefined && this.#clock() - kept.acceptedAt < KEY_RETENTION_MS
            ? kept
            : undefined;
        if (previous !== undefined) {
          if (previous.body !== raw.toString("utf8"))
            throw new HttpError(409, "idempotency_key_reused");
          const existing = this.sandboxes.get(previous.id);
          if (existing === undefined) throw new HttpError(404, "sandbox_not_found");
          return send(200, { ok: true, sandbox: this.#view(existing) });
        }
        const fault = this.faults.create?.(body);
        const sandbox = this.#create(body, fault === "stuck");
        this.#idempotency.set(key, {
          body: raw.toString("utf8"),
          id: sandbox.id,
          acceptedAt: this.#clock(),
        });
        if (fault === "lose-reply") {
          this.#record("fault:create-reply-lost", sandbox.id);
          response.destroy();
          return;
        }
        return send(202, { ok: true, sandbox: this.#view(sandbox) });
      }
      if (method === "GET" && path === "/sandboxes") return send(200, this.#inventory(url));
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)$/))) {
        const id = match[1] ?? "";
        if (method === "GET")
          return send(200, {
            ok: true,
            sandbox: this.#view(this.#sandbox(id)),
          });
        if (method === "DELETE") {
          if (request.headers["x-ascii-confirm-delete"] !== id)
            throw new HttpError(400, "delete_confirmation_required");
          // Recorded: Boat accepts a deletion with 202 and an operation to poll.
          return send(202, {
            ok: true,
            operation: this.#delete(this.#sandbox(id)),
          });
        }
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/commands$/)) && method === "POST") {
        const sandbox = this.#sandbox(match[1] ?? "");
        const body = commandBody.parse(json());
        await this.faults.beforeCommand?.(body.command, sandbox);
        if (body.detached === true) {
          const { reply, dropAfterMs } = this.#startDetached(sandbox, body);
          if (dropAfterMs !== undefined) {
            // A lost start reply: the process runs, but Core never learns its handle.
            this.#record(
              "fault:detached-start-reply-dropped",
              sandbox.id,
              body.command.slice(0, 200),
            );
            await delay(dropAfterMs);
            response.destroy();
            return;
          }
          return send(200, reply);
        }
        const fault = this.faults.command?.(body.command, sandbox);
        if (fault?.kind === "drop") {
          this.#record("fault:command-reply-dropped", sandbox.id, body.command.slice(0, 200));
          void this.#exec(sandbox, body.command, body.timeoutSeconds);
          await delay(fault.afterMs);
          response.destroy();
          return;
        }
        return send(200, {
          ok: true,
          ...(await this.#runSync(sandbox, body, fault)),
        });
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/commands\/(\d+)$/))) {
        this.#sandbox(match[1] ?? "");
        const process = this.#processes.get(Number(match[2]));
        if (process === undefined || process.sandboxId !== match[1])
          return send(200, {
            ok: true,
            processId: Number(match[2]),
            status: "lost",
            known: false,
            running: false,
            exitCode: null,
            stdout: "",
            stderr: "",
          });
        if (method === "GET")
          return send(200, {
            ok: true,
            processId: process.id,
            status: process.running ? "running" : "exited",
            known: true,
            running: process.running,
            exitCode: process.running ? null : process.exitCode,
            stdout: tail(process.stdout),
            stderr: tail(process.stderr),
            ...(process.stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(process.stderrTruncated ? { stderrTruncated: true } : {}),
          });
        if (method === "DELETE") {
          const signaled = process.running;
          if (signaled) await this.#killDetached(process);
          return send(200, {
            ok: true,
            processId: process.id,
            running: false,
            signaled,
          });
        }
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/files$/)) && method === "PUT") {
        const sandbox = this.#sandbox(match[1] ?? "");
        const body = fileBody.parse(json());
        await this.#writeGuestFile(sandbox, body.path, Buffer.from(body.content, "utf8"));
        return send(200, { ok: true });
      }
      if (
        (match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/files\/upload-url$/)) &&
        method === "POST"
      ) {
        const sandbox = this.#sandbox(match[1] ?? "");
        const body = uploadBody.parse(json());
        const token = randomBytes(24).toString("hex");
        this.#uploads.set(token, {
          sandboxId: sandbox.id,
          path: body.path,
          expires: Date.now() + body.ttlSeconds * 1000,
        });
        return send(200, {
          ok: true,
          url: `https://files-${hostLabel(sandbox.id)}.on.boat.dev/upload/${token}`,
          method: "PUT",
          path: body.path,
        });
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/host$/)) && method === "POST") {
        const sandbox = this.#sandbox(match[1] ?? "");
        const body = hostBody.parse(json());
        return send(200, {
          ok: true,
          url: `https://${hostLabel(sandbox.id)}-${body.port}.on.boat.dev/?_token=${sandbox.hostToken}`,
          isProtected: true,
        });
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/stop$/)) && method === "POST") {
        const sandbox = this.#sandbox(match[1] ?? "");
        sandbox.state = "archiving";
        this.#track(this.#archive(sandbox));
        return send(202, { ok: true });
      }
      if ((match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)\/resume$/)) && method === "POST") {
        const sandbox = this.#sandbox(match[1] ?? "");
        resumeBody.parse(json());
        sandbox.state = "provisioned";
        sandbox.stoppedAt = null;
        this.#track(this.#boot(sandbox, "resume"));
        return send(202, { ok: true });
      }
      if (
        (match = path.match(/^\/deletion-operations\/(bdop_[a-f0-9]{32})$/)) &&
        method === "GET"
      ) {
        const deletion = this.deletions.get(match[1] ?? "");
        if (deletion === undefined) throw new HttpError(404, "not_found");
        return send(200, {
          ok: true,
          operation: { ...deletion, kind: "sandbox" },
        });
      }
      if (path === "/saved-snapshots" && method === "POST" && this.options.trialAccount === true)
        throw new HttpError(403, "trial_saved_snapshots_not_allowed");
      if (path === "/saved-snapshots" && method === "POST")
        return send(202, {
          ok: true,
          snapshot: this.#save(snapshotBody.parse(json())),
        });
      if (path === "/saved-snapshots" && method === "GET") {
        const snapshots = [...this.snapshots.values()].map((snapshot) =>
          this.#snapshotView(snapshot),
        );
        return send(200, {
          ok: true,
          snapshots,
          allowance: {
            org: null,
            included: 10,
            used: snapshots.length,
            extra: Math.max(0, snapshots.length - 10),
            extraDailyDollars: 0,
          },
        });
      }
      if ((match = path.match(/^\/saved-snapshots\/([a-z0-9-]+)$/))) {
        const snapshot = this.snapshots.get(match[1] ?? "");
        if (snapshot === undefined) throw new HttpError(404, "not_found");
        if (method === "GET")
          return send(200, {
            ok: true,
            snapshot: this.#snapshotView(snapshot),
          });
        if (method === "DELETE") {
          this.snapshots.delete(snapshot.name);
          await this.#docker(["image", "rm", "-f", snapshot.image]);
          await this.#docker(["volume", "rm", "-f", snapshot.dockerData]);
          this.#record("snapshot-deleted", snapshot.sourceSandboxId, snapshot.name);
          return send(200, {
            ok: true,
            name: snapshot.name,
            status: "deleted",
          });
        }
      }
      if ((match = path.match(/^\/snapshots\/([A-Za-z0-9_-]+)\/files$/)) && method === "GET")
        return this.#snapshotFile(match[1] ?? "", url.searchParams.get("path") ?? "", response);
      throw new HttpError(404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { ok: false, code: error.code });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return send(400, { ok: false, code: "invalid_request" });
      this.#record("api-error", undefined, String(error));
      return send(500, { ok: false, code: "internal_error" });
    }
  }

  #inventory(url: URL) {
    const wanted = url.searchParams.getAll("label").map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index), pair.slice(index + 1)] as const;
    });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 200);
    const size = Math.min(limit, this.options.pageSize ?? 200);
    const all = this.liveSandboxes().filter((sandbox) =>
      wanted.every(([key, value]) => sandbox.labels[key] === value),
    );
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : null;
    return {
      ok: true,
      sandboxes: page.map((sandbox) => this.#view(sandbox)),
      pageInfo: { nextCursor: next, hasMore: next !== null, limit: size },
    };
  }

  #create(body: z.infer<typeof createBody>, stuck: boolean): FakeSandbox {
    let image = this.options.baseImage;
    let dockerSeed: string | undefined;
    if (body.from !== undefined) {
      const snapshot = this.snapshots.get(body.from);
      if (snapshot === undefined || snapshot.status !== "ready")
        throw new HttpError(404, "snapshot_not_found");
      image = snapshot.image;
      dockerSeed = snapshot.dockerData;
    }
    const id = newSandboxId();
    const sandbox: FakeSandbox = {
      id,
      labels: body.labels,
      ttlSeconds: body.ttlSeconds,
      snapshots: body.snapshots ?? false,
      monitoring: body.monitoring,
      container: `boat-harness-${this.options.runId}-${id.replace("_", "-")}`,
      image,
      createdAt: now(),
      hostToken: randomBytes(24).toString("hex"),
      state: "provisioned",
      hydrated: undefined,
      stoppedAt: null,
      ip: undefined,
      deletion: undefined,
      removed: false,
      dockerSeed,
    };
    this.sandboxes.set(id, sandbox);
    this.#record("create", id, body.from ?? "base");
    this.#track(this.#provision(sandbox, stuck));
    return sandbox;
  }

  async #provision(sandbox: FakeSandbox, stuck: boolean) {
    // Recorded: `provisioned` at create, `cloning` ~60 ms later, `idle` ~2 s after that.
    await delay(60);
    if (sandbox.removed || sandbox.deletion !== undefined) return;
    sandbox.state = "cloning";
    if (stuck) {
      this.#record("fault:provisioning-stuck", sandbox.id);
      return;
    }
    // The workspace's own dockerd keeps its layers under /var/lib/sealant/docker. On a VM that is
    // a disk; in the twin it would be the container's overlay root, which overlayfs refuses as an
    // upper layer, so each twin gets a volume there (this run's label; removed with it).
    const dockerData = `${sandbox.container}-docker`;
    await this.#dockerOk([
      "volume",
      "create",
      "--label",
      `${HARNESS_LABEL}=${this.options.runId}`,
      dockerData,
    ]);
    if (sandbox.dockerSeed !== undefined) await this.#copyVolume(sandbox.dockerSeed, dockerData);
    await this.#dockerOk([
      "run",
      "-d",
      "--name",
      sandbox.container,
      "--hostname",
      sandbox.id.replace("_", "-"),
      "--label",
      `${HARNESS_LABEL}=${this.options.runId}`,
      "--label",
      `${HARNESS_LABEL}.sandbox=${sandbox.id}`,
      "--privileged",
      "--cgroupns",
      "private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "-v",
      `${dockerData}:/var/lib/sealant/docker`,
      "--network",
      this.options.network,
      ...(this.options.extraHosts ?? []).flatMap((entry) => ["--add-host", entry]),
      sandbox.image,
    ]);
    await this.#boot(sandbox, "create");
  }

  async #boot(sandbox: FakeSandbox, reason: "create" | "resume") {
    if (reason === "resume") await this.#dockerOk(["start", sandbox.container]);
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (sandbox.removed || sandbox.deletion !== undefined) return;
      const state = await this.#docker(
        ["exec", sandbox.container, "systemctl", "is-system-running"],
        {
          timeoutMs: 10_000,
        },
      );
      const value = state.stdout.trim();
      if (value === "running" || value === "degraded") break;
      if (Date.now() > deadline) {
        sandbox.state = "error";
        this.#record("boot-timeout", sandbox.id, value);
        return;
      }
      await delay(250);
    }
    // What Boat does to a VM cloned from a saved snapshot before anyone can reach it
    // (docs/experiments/boat-native-guest-startup.md): it restores its own systemd executable and
    // rewrites the base .bashrc to different bytes of the same length (here, the sandbox ID).
    if (reason === "create" && sandbox.image !== this.options.baseImage)
      await this.#dockerOk([
        "exec",
        sandbox.container,
        "/bin/sh",
        "-c",
        "cp --remove-destination /var/lib/boat-twin/provider-systemd /usr/lib/systemd/systemd && " +
          `sed -i 's/^# boat-sandbox bx_[a-z0-9]\\{8\\}$/# boat-sandbox ${sandbox.id}/' /home/user/.bashrc`,
      ]);
    sandbox.ip = (
      await this.#dockerOk([
        "inspect",
        "-f",
        `{{(index .NetworkSettings.Networks "${this.options.network}").IPAddress}}`,
        sandbox.container,
      ])
    ).trim();
    sandbox.hydrated = true;
    sandbox.state = "idle";
    this.#record(`booted:${reason}`, sandbox.id);
  }

  async #archive(sandbox: FakeSandbox) {
    await this.#docker(["stop", "-t", "10", sandbox.container]);
    sandbox.state = "archived";
    sandbox.stoppedAt = now();
    sandbox.ip = undefined;
    this.#record("archived", sandbox.id);
  }

  #delete(sandbox: FakeSandbox): FakeDeletion & { kind: "sandbox" } {
    if (sandbox.deletion !== undefined) return { ...sandbox.deletion, kind: "sandbox" };
    const deletion: FakeDeletion = {
      id: `bdop_${randomUUID().replaceAll("-", "")}`,
      targetId: sandbox.id,
      status: "pending",
    };
    sandbox.deletion = deletion;
    this.deletions.set(deletion.id, deletion);
    this.#record("delete", sandbox.id, deletion.id);
    const stuck = this.faults.deletion?.(sandbox) === "stuck";
    this.#track(
      (async () => {
        await delay(100);
        deletion.status = "processing";
        if (stuck) {
          this.#record("fault:deletion-stuck", sandbox.id);
          return;
        }
        for (const process of this.#processes.values())
          if (process.sandboxId === sandbox.id && process.running) process.child.kill("SIGKILL");
        await this.#docker(["rm", "-f", "-v", sandbox.container]);
        await delay(100);
        sandbox.removed = true;
        sandbox.ip = undefined;
        deletion.status = "completed";
        this.#record("deleted", sandbox.id);
      })(),
    );
    return { ...deletion, kind: "sandbox" };
  }

  /** Lets a stuck deletion finish, for scenarios that release a fault mid-way. */
  async completeDeletion(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (sandbox?.deletion === undefined) return;
    await this.#docker(["rm", "-f", "-v", sandbox.container]);
    sandbox.removed = true;
    sandbox.deletion.status = "completed";
  }

  #save(body: z.infer<typeof snapshotBody>): SnapshotView {
    const sandbox = this.#sandbox(body.sandboxId);
    if (this.snapshots.has(body.name)) throw new HttpError(409, "snapshot_name_taken");
    const snapshot: FakeSnapshot = {
      name: body.name,
      sourceSandboxId: sandbox.id,
      snapshotId: randomUUID(),
      createdAt: now(),
      image: `sealant-boat-twin-snapshot:${this.options.runId}-${body.name}`.slice(0, 128),
      dockerData: `boat-harness-${this.options.runId}-snapshot-${body.name}-docker`,
      status: "saving",
    };
    this.snapshots.set(snapshot.name, snapshot);
    this.#record("snapshot-save", sandbox.id, snapshot.name);
    const failed = this.faults.snapshot?.(body.name) === "failed";
    this.#track(
      (async () => {
        if (failed) {
          await delay(200);
          snapshot.status = "failed";
          this.#record("fault:snapshot-failed", sandbox.id, snapshot.name);
          return;
        }
        await this.#dockerOk([
          "commit",
          "--change",
          `LABEL ${HARNESS_LABEL}=${this.options.runId}`,
          sandbox.container,
          snapshot.image,
        ]);
        // `docker commit` leaves volumes out; the VM's disk includes its Docker data.
        await this.#dockerOk([
          "volume",
          "create",
          "--label",
          `${HARNESS_LABEL}=${this.options.runId}`,
          snapshot.dockerData,
        ]);
        await this.#copyVolume(`${sandbox.container}-docker`, snapshot.dockerData);
        snapshot.status = "ready";
        this.#record("snapshot-ready", sandbox.id, snapshot.name);
      })(),
    );
    return this.#snapshotView(snapshot);
  }

  /** Copies one volume's files into another, owners and modes kept, in a short-lived container. */
  async #copyVolume(from: string, to: string) {
    await this.#dockerOk([
      "run",
      "--rm",
      "--label",
      `${HARNESS_LABEL}=${this.options.runId}`,
      "-v",
      `${from}:/from:ro`,
      "-v",
      `${to}:/to`,
      "--entrypoint",
      "cp",
      this.options.baseImage,
      "-a",
      "/from/.",
      "/to/",
    ]);
  }

  #snapshotFile(snapshotId: string, path: string, response: http.ServerResponse) {
    const snapshot = [...this.snapshots.values()].find((entry) => entry.snapshotId === snapshotId);
    if (snapshot === undefined || snapshot.status !== "ready")
      throw new HttpError(404, "snapshot_not_found");
    // The one file Core reads back from a saved snapshot: the agent's park receipt.
    if (!/^\/var\/lib\/sealant\/agent\/park-[a-f0-9-]{36}\.json$/.test(path))
      throw new HttpError(400, "invalid_path");
    const child = spawn("docker", [
      "run",
      "--rm",
      "--label",
      `${HARNESS_LABEL}=${this.options.runId}`,
      "--entrypoint",
      "/bin/cat",
      snapshot.image,
      path,
    ]);
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    child.stdout.pipe(response);
    child.once("close", (code) => {
      if (code !== 0) response.destroy();
    });
  }

  #execArgs(sandbox: FakeSandbox, command: string, timeoutSeconds: number, extra: string[] = []) {
    return [
      "exec",
      "-i",
      "--user",
      "1000:1000",
      "--workdir",
      "/home/user",
      "--env",
      "HOME=/home/user",
      "--env",
      "USER=user",
      "--env",
      "LOGNAME=user",
      sandbox.container,
      ...extra,
      "timeout",
      "--kill-after=2",
      String(timeoutSeconds),
      "/bin/bash",
      "-c",
      command,
    ];
  }

  async #exec(sandbox: FakeSandbox, command: string, timeoutSeconds: number) {
    const result = await this.#docker(this.#execArgs(sandbox, command, timeoutSeconds), {
      timeoutMs: (timeoutSeconds + 10) * 1000,
    });
    const timedOut = result.timedOut || result.code === 124 || result.code === 137;
    return {
      exitCode: timedOut ? null : result.code,
      timedOut,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  }

  async #runSync(
    sandbox: FakeSandbox,
    body: z.infer<typeof commandBody>,
    fault: CommandFault | undefined,
  ) {
    if (sandbox.state !== "idle" && sandbox.state !== "running")
      throw new HttpError(409, "sandbox_not_running");
    this.#record("command", sandbox.id, body.command.slice(0, 300));
    if (fault?.kind === "exit") {
      this.#record("fault:command-exit", sandbox.id, String(fault.code));
      return {
        exitCode: fault.code,
        timedOut: false,
        stdout: "",
        stderr: fault.stderr ?? "",
      };
    }
    if (fault?.kind === "timeout") {
      this.#record("fault:command-timeout", sandbox.id);
      await delay(Math.min(body.timeoutSeconds, 30) * 1000);
      return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
    }
    if (fault?.kind === "delay") {
      this.#record("fault:command-delayed", sandbox.id, String(fault.ms));
      await delay(fault.ms);
    }
    sandbox.state = "running";
    try {
      const result = await this.#exec(sandbox, body.command, body.timeoutSeconds);
      await this.faults.afterCommand?.(body.command, sandbox);
      return result;
    } finally {
      if (sandbox.state === "running") sandbox.state = "idle";
    }
  }

  #startDetached(sandbox: FakeSandbox, body: z.infer<typeof commandBody>) {
    if (sandbox.state !== "idle" && sandbox.state !== "running")
      throw new HttpError(409, "sandbox_not_running");
    const id = this.#nextProcess++;
    this.#record("command:detached", sandbox.id, body.command.slice(0, 300));
    const pidFile = `/tmp/.boat-harness-process-${id}`;
    const fault = this.faults.command?.(body.command, sandbox);
    if (fault !== undefined)
      this.#record(`fault:detached-${fault.kind}`, sandbox.id, body.command.slice(0, 200));
    // A session leader per process lets DELETE kill the whole tree, as Boat's stop does.
    const wrapped = `echo $$ > ${pidFile}; exec /bin/bash -c "$BOAT_HARNESS_COMMAND"`;
    const child = spawn("docker", [
      "exec",
      "--user",
      "1000:1000",
      "--workdir",
      "/home/user",
      "--env",
      "HOME=/home/user",
      "--env",
      "USER=user",
      "--env",
      "LOGNAME=user",
      "--env",
      `BOAT_HARNESS_COMMAND=${
        fault?.kind === "exit"
          ? `echo ${JSON.stringify(fault.stderr ?? "")} >&2; exit ${fault.code}`
          : fault?.kind === "timeout"
            ? `sleep ${body.timeoutSeconds + 5}`
            : fault?.kind === "delay"
              ? `sleep ${Math.ceil(fault.ms / 1000)}; ${body.command}`
              : body.command
      }`,
      sandbox.container,
      "setsid",
      "--wait",
      "timeout",
      "--kill-after=2",
      String(body.timeoutSeconds),
      "/bin/bash",
      "-c",
      wrapped,
    ]);
    const process: DetachedProcess = {
      id,
      sandboxId: sandbox.id,
      child,
      pidFile,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: null,
      running: true,
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const next = process.stdout + chunk.toString("utf8");
      if (Buffer.byteLength(next) > OUTPUT_LIMIT) process.stdoutTruncated = true;
      process.stdout = tail(next);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = process.stderr + chunk.toString("utf8");
      if (Buffer.byteLength(next) > OUTPUT_LIMIT) process.stderrTruncated = true;
      process.stderr = tail(next);
    });
    const after = this.faults.afterCommand;
    child.once("close", (code) => {
      void (async () => {
        await after?.(body.command, sandbox).catch((error: unknown) => {
          this.#record("fault:after-command-error", sandbox.id, String(error));
        });
        process.running = false;
        process.exitCode = code;
        this.#record("command:detached-exit", sandbox.id, String(code));
      })();
    });
    this.#processes.set(id, process);
    return {
      reply: { ok: true, processId: id },
      dropAfterMs: fault?.kind === "drop" ? fault.afterMs : undefined,
    };
  }

  async #killDetached(process: DetachedProcess) {
    const sandbox = this.sandboxes.get(process.sandboxId);
    if (sandbox !== undefined)
      await this.#docker([
        "exec",
        sandbox.container,
        "/bin/sh",
        "-c",
        `kill -KILL -- -"$(cat ${process.pidFile})" 2>/dev/null; true`,
      ]);
    process.child.kill("SIGKILL");
  }

  async #writeGuestFile(sandbox: FakeSandbox, path: string, bytes: Buffer) {
    const result = await this.#docker(
      [
        "exec",
        "-i",
        "--user",
        "1000:1000",
        sandbox.container,
        "/bin/sh",
        "-c",
        'cat > "$1"',
        "sh",
        path,
      ],
      { input: bytes, timeoutMs: 60_000 },
    );
    if (result.code !== 0) throw new HttpError(400, "file_write_failed");
  }

  // ---- Hosted port proxy -------------------------------------------------------------------

  #route(host: string | undefined): { sandbox: FakeSandbox; port: number } | "upload" | undefined {
    const name = (host ?? "").split(":")[0] ?? "";
    if (/^files-bx-[a-z0-9]{8}\.on\.boat\.dev$/.test(name)) return "upload";
    const match = name.match(/^(bx-[a-z0-9]{8})-(\d+)\.on\.boat\.dev$/);
    if (match === null) return undefined;
    const sandbox = this.sandboxes.get((match[1] ?? "").replace("-", "_"));
    if (sandbox === undefined || sandbox.removed) return undefined;
    return { sandbox, port: Number(match[2]) };
  }

  #authorized(request: http.IncomingMessage, sandbox: FakeSandbox): boolean {
    const cookies = (request.headers.cookie ?? "").split(";").map((part) => part.trim());
    return cookies.includes(`_port_auth=${sandbox.hostToken}`);
  }

  async #serveProxy(request: http.IncomingMessage, response: http.ServerResponse) {
    // The worker has no Boat base-URL setting, so the preload sends `https://boat.dev` here too.
    if ((request.headers.host ?? "").split(":")[0] === "boat.dev")
      return this.#serveApi(request, response);
    const route = this.#route(request.headers.host);
    const url = new URL(request.url ?? "/", "https://proxy.invalid");
    if (route === "upload") return this.#upload(request, response, url);
    if (route === undefined) {
      response.writeHead(404).end("Not Found");
      return;
    }
    const { sandbox, port } = route;
    if (url.searchParams.get("_token") === sandbox.hostToken) {
      response
        .writeHead(302, {
          Location: "/",
          "Set-Cookie": `_port_auth=${sandbox.hostToken}; Path=/; HttpOnly; Secure`,
        })
        .end();
      return;
    }
    if (!this.#authorized(request, sandbox)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    await this.faults.beforeProxy?.(url.pathname, request.method ?? "GET", sandbox);
    const fault = this.faults.proxy?.(url.pathname, request.method ?? "GET", sandbox);
    if (fault !== undefined) {
      this.#record(`fault:proxy-${fault.kind}`, sandbox.id, url.pathname);
      if (fault.kind === "destroy") {
        request.socket.destroy();
        return;
      }
      response.writeHead(fault.status, { "Content-Type": "application/json" }).end(fault.body);
      return;
    }
    if (sandbox.ip === undefined || sandbox.state === "archived") {
      response.writeHead(this.options.closedPortStatus ?? 502).end("Bad Gateway");
      return;
    }
    const headers = { ...request.headers };
    delete headers.cookie;
    const upstream = http.request(
      {
        host: sandbox.ip,
        port,
        method: request.method,
        path: request.url,
        headers,
      },
      (reply) => {
        // Every guest answer is evidence: e.g. the relay's 404 for a route it does not forward.
        this.#record("proxy", sandbox.id, `${request.method} ${url.pathname} ${reply.statusCode}`);
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent)
        response.writeHead(this.options.closedPortStatus ?? 502).end("Bad Gateway");
      else response.destroy();
    });
    request.pipe(upstream);
  }

  async #upload(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
    const token = url.pathname.match(/^\/upload\/([a-f0-9]{48})$/)?.[1];
    const upload = token === undefined ? undefined : this.#uploads.get(token);
    if (request.method !== "PUT" || upload === undefined || upload.expires < Date.now()) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (token !== undefined) this.#uploads.delete(token);
    const sandbox = this.sandboxes.get(upload.sandboxId);
    if (sandbox === undefined) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readBody(request);
    try {
      await this.#writeGuestFile(sandbox, upload.path, bytes);
      response.writeHead(200).end();
    } catch {
      response.writeHead(500).end();
    }
  }

  #upgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const route = this.#route(request.headers.host);
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    if (route === undefined || route === "upload") return refuse(404, "Not Found");
    const { sandbox, port } = route;
    if (!this.#authorized(request, sandbox)) return refuse(403, "Forbidden");
    const path = new URL(request.url ?? "/", "https://proxy.invalid").pathname;
    // The same faults as plain requests: Core's tunnel carrier is a WebSocket through this proxy.
    const fault = this.faults.proxy?.(path, "GET", sandbox);
    if (fault !== undefined) {
      this.#record(`fault:proxy-${fault.kind}`, sandbox.id, `upgrade ${path}`);
      if (fault.kind === "destroy") {
        socket.destroy();
        return;
      }
      return refuse(fault.status, "Refused");
    }
    if (sandbox.ip === undefined)
      return refuse(this.options.closedPortStatus ?? 502, "Bad Gateway");
    const upstream = net.connect({ host: sandbox.ip, port });
    upstream.once("connect", () => {
      this.#record("proxy-upgrade", sandbox.id, path);
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const key = request.rawHeaders[index] ?? "";
        if (key.toLowerCase() === "cookie") continue;
        lines.push(`${key}: ${request.rawHeaders[index + 1] ?? ""}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("error", () => refuse(this.options.closedPortStatus ?? 502, "Bad Gateway"));
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  }
}

/** Boat's hosted hostnames are DNS labels; the sandbox ID's underscore becomes a hyphen. */
const hostLabel = (id: string) => id.replace("_", "-");

const readBody = async (request: http.IncomingMessage): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of request)
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
  return Buffer.concat(parts);
};
