/**
 * A fake Boat control plane that behaves as recorded, not as convenient. Facts it keeps
 * (docs/experiments/boat-provider-lifetime-evidence.json, boat-runtime.md, api.test.ts):
 *
 * - Create needs an `Idempotency-Key`, answers 202 with the VM in `provisioned`, and replays the
 *   same VM for the same key for 24 hours; after that the key is forgotten and a replay creates
 *   another VM. Reads then move it through `cloning` to `idle`.
 * - Discovery is a paginated label query with `pageInfo`.
 * - DELETE needs `X-Ascii-Confirm-Delete: <id>` and answers with a deletion operation that is
 *   `pending`, then `processing`, then `completed`. By default it completes as it is polled; with
 *   `completeDeletionsIndependently` Boat finishes it on its own, polled or not. With
 *   `blockDeletions` the operation reads `blocked` while the VM already reads 404.
 * - A VM Boat does not have is a typed 404 `sandbox_not_found`.
 * - Commands run as uid 1000; this fake runs no commands and refuses them, so no test can pass by
 *   pretending a guest answered.
 *
 * Faults are explicit switches named for what they inject.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

import { z } from "zod";

/** Boat keeps an idempotency key for 24 hours (docs/experiments/boat-provider-lifetime.md). */
const KEY_RETENTION_MS = 24 * 60 * 60_000;
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const sandboxId = () =>
  `bx_${Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;

export interface RecordedVm {
  readonly id: string;
  readonly key: string;
  /** The fake's clock when Boat accepted the create (key retention runs from here). */
  readonly acceptedAt?: number;
  readonly labels: Record<string, string>;
  state: "provisioned" | "cloning" | "idle";
}
interface Deletion {
  readonly id: string;
  readonly targetId: string;
  polls: number;
  /** Boat finished it on its own, whether or not anyone polled. */
  completed?: boolean;
}

export class RecordedBoat {
  readonly vms = new Map<string, RecordedVm>();
  /** The Boat account every key here belongs to, as `/me` answers it (`user.id`). */
  identity = "usr_recorded";
  readonly deletions = new Map<string, Deletion>();
  readonly requests: string[] = [];
  /**
   * The bearer each request carried, in order: which key sealant called Boat with. Fixture keys
   * only.
   */
  readonly bearers: string[] = [];
  /** Saved snapshots by name, as `GET /saved-snapshots/:name` returns them. */
  readonly savedSnapshots = new Map<
    string,
    {
      name: string;
      status: "ready";
      sourceSandboxId: string;
      createdAt: string;
      snapshotId?: string | undefined;
    }
  >();
  /** Fault: Boat accepted create but cannot read the VM yet (eventually consistent read). */
  unreadableAfterCreate = 0;
  /** Fault: provisioning never finishes; reads keep reporting `provisioned`. */
  stuckProvisioning = false;
  /** Runs before a VM read is answered, to interleave another writer. */
  beforeRead: () => Promise<void> = async () => {};
  /**
   * Runs when a create reaches Boat, before Boat acts on it (and before `rejectCreate` is read), to
   * hold one request while other actors move. `key`: the create's idempotency key.
   */
  beforeCreate: (key: string) => Promise<void> = async () => {};
  /** Runs before a label listing is answered, to interleave another writer. */
  beforeList: () => Promise<void> = async () => {};
  /** Fault: Boat accepted a create but its inventory does not list the VM yet. */
  unlisted = false;
  /** Fault: Boat refuses every create outright with this status and code. */
  rejectCreate: { readonly status: number; readonly code: string } | undefined;
  /** Fault: the create reply is lost after Boat accepted it. */
  loseCreateReply = false;
  /** Fault: Boat becomes unreachable right after a create reply is lost (a longer outage). */
  outageAfterLostCreate = false;
  /** Fault: the DELETE reply is lost after Boat accepted and completed it. */
  loseDeleteReply = false;
  /** Fault: every request fails at the transport. */
  unreachable = false;
  /**
   * The keys this Boat account accepts; any other is refused with Boat's 401, as Boat refuses a key
   * that is not this account's. Absent: every key is accepted.
   */
  acceptsOnly: readonly string[] | undefined;
  /** How many polls a deletion takes to complete. */
  deletionPolls = 2;
  /** Boat completes each deletion right after accepting it, without being polled. */
  completeDeletionsIndependently = false;
  /** Boat removes the VM (404) but reports the operation `blocked` until `unblockDeletions`. */
  blockDeletions = false;

  /** Boat finishes every accepted deletion on its own, as it does while no worker polls. */
  finishDeletions() {
    for (const deletion of this.deletions.values()) {
      deletion.completed = true;
      this.vms.delete(deletion.targetId);
    }
  }

  unblockDeletions() {
    this.blockDeletions = false;
    for (const deletion of this.deletions.values()) deletion.completed = true;
  }
  #server: http.Server | undefined;
  /** How far the fake's clock has been moved past real time. */
  #offsetMs = 0;

  /** Move Boat's clock forward, as hours passing between a lost reply and its recovery would. */
  elapse(ms: number) {
    this.#offsetMs += ms;
  }

  #now() {
    return Date.now() + this.#offsetMs;
  }

  /** Out-of-band removal, as when a person deletes the VM in Boat's console. */
  removeOutOfBand(id: string) {
    this.vms.delete(id);
  }

  async listen(): Promise<string> {
    this.#server = http.createServer((request, response) => {
      void this.#serve(request, response).catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return `http://127.0.0.1:${address.port}/api/v1`;
  }

  async close() {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  #view(vm: RecordedVm) {
    return {
      id: vm.id,
      state: vm.state,
      labels: vm.labels,
      archiveAfter: null,
      ttlSeconds: null,
      snapshots: true,
      monitoring: false,
      hydrated: vm.state === "idle",
      dataExpiredAt: null,
      stoppedAt: null,
    };
  }

  async #serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://boat");
    this.requests.push(`${request.method} ${url.pathname}`);
    this.bearers.push((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (this.unreachable) {
      response.destroy();
      return;
    }
    if (this.acceptsOnly !== undefined && !this.acceptsOnly.includes(this.bearers.at(-1) ?? "")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "unauthorized" }));
      return;
    }
    let raw = "";
    for await (const part of request) raw += String(part);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const path = url.pathname.replace(/^\/api\/v1/, "");
    // The account reads a key check makes: a personal key with every permission, in its own
    // wallet (the only one), which can start a VM. What resolves an install's or an account's
    // wallet reads; nothing here keeps wallets apart.
    if (request.method === "GET" && path === "/me")
      return send(200, {
        ok: true,
        user: { id: this.identity, login: "recorded", accountStatus: "active" },
      });
    if (request.method === "GET" && path === "/orgs")
      return send(200, {
        ok: true,
        orgs: [
          { id: "usr_recorded", name: "recorded", type: "personal", role: "owner", active: true },
        ],
      });
    if (request.method === "GET" && path === "/limits")
      return send(200, {
        ok: true,
        canStart: true,
        activeSandboxes: 0,
        maxActiveSandboxes: 10,
      });
    if (request.method === "GET" && path === "/api-keys") {
      const bearer = this.bearers.at(-1) ?? "";
      return send(200, {
        ok: true,
        apiKeys: [
          {
            id: "key_recorded",
            name: "sealant",
            keyPrefix: bearer.slice(0, 9),
            keyLastFour: bearer.slice(-4),
            teamId: null,
            expiresAt: null,
            neverExpires: true,
            scope: { actions: ["*"], sandboxes: "*", environments: "*" },
          },
        ],
        catalog: { presets: {} },
      });
    }
    if (request.method === "POST" && path === "/sandboxes") {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") return send(400, { ok: false, code: "invalid_request" });
      await this.beforeCreate(key);
      if (this.rejectCreate !== undefined)
        return send(this.rejectCreate.status, { ok: false, code: this.rejectCreate.code });
      const body = z
        .object({ labels: z.record(z.string(), z.string()) })
        .passthrough()
        .parse(JSON.parse(raw));
      const existing = [...this.vms.values()].find(
        (vm) => vm.key === key && this.#now() - (vm.acceptedAt ?? this.#now()) < KEY_RETENTION_MS,
      );
      const vm = existing ?? {
        id: sandboxId(),
        key,
        acceptedAt: this.#now(),
        labels: body.labels,
        state: "provisioned" as const,
      };
      this.vms.set(vm.id, vm);
      if (this.loseCreateReply) {
        if (this.outageAfterLostCreate) this.unreachable = true;
        response.destroy();
        return;
      }
      return send(202, { ok: true, sandbox: this.#view(vm) });
    }
    if (request.method === "GET" && path === "/sandboxes") {
      await this.beforeList();
      const wanted = url.searchParams.getAll("label").map((pair) => pair.split("="));
      const sandboxes = [...this.vms.values()]
        .filter(() => !this.unlisted)
        .filter((vm) =>
          wanted.every(([key, value]) => key !== undefined && vm.labels[key] === value),
        )
        .map((vm) => this.#view(vm));
      return send(200, {
        ok: true,
        sandboxes,
        pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
      });
    }
    const sandbox = /^\/sandboxes\/(bx_[a-z0-9]{8})$/.exec(path);
    if (sandbox !== null && request.method === "GET") {
      await this.beforeRead();
      const vm = this.vms.get(sandbox[1] ?? "");
      if (vm === undefined || this.unreadableAfterCreate > 0) {
        if (vm !== undefined) this.unreadableAfterCreate -= 1;
        return send(404, { ok: false, code: "sandbox_not_found" });
      }
      const view = this.#view(vm);
      if (!this.stuckProvisioning) vm.state = vm.state === "provisioned" ? "cloning" : "idle";
      return send(200, { ok: true, sandbox: view });
    }
    if (sandbox !== null && request.method === "DELETE") {
      const id = sandbox[1] ?? "";
      if (request.headers["x-ascii-confirm-delete"] !== id)
        return send(400, { ok: false, code: "invalid_request" });
      if (!this.vms.has(id)) return send(404, { ok: false, code: "sandbox_not_found" });
      const deletion: Deletion = {
        id: `bdop_${randomUUID().replaceAll("-", "")}`,
        targetId: id,
        polls: 0,
      };
      this.deletions.set(deletion.id, deletion);
      if (this.completeDeletionsIndependently) {
        this.vms.delete(id);
        deletion.completed = true;
      }
      if (this.blockDeletions) this.vms.delete(id);
      if (this.loseDeleteReply) {
        this.vms.delete(id);
        deletion.polls = this.deletionPolls;
        response.destroy();
        return;
      }
      return send(202, {
        ok: true,
        operation: { id: deletion.id, kind: "sandbox", targetId: id, status: "pending" },
      });
    }
    const saved = /^\/saved-snapshots\/([a-z0-9-]{1,63})$/.exec(path);
    if (saved !== null && request.method === "GET") {
      const snapshot = this.savedSnapshots.get(saved[1] ?? "");
      return snapshot === undefined
        ? send(404, { ok: false, code: "snapshot_not_found" })
        : send(200, { ok: true, snapshot });
    }
    const operation = /^\/deletion-operations\/(bdop_[a-f0-9]{32})$/.exec(path);
    if (operation !== null && request.method === "GET") {
      const deletion = this.deletions.get(operation[1] ?? "");
      if (deletion === undefined) return send(404, { ok: false, code: "not_found" });
      deletion.polls += 1;
      const blocked = this.blockDeletions && deletion.completed !== true;
      const completed =
        !blocked && (deletion.completed === true || deletion.polls >= this.deletionPolls);
      if (completed) this.vms.delete(deletion.targetId);
      return send(200, {
        ok: true,
        operation: {
          id: deletion.id,
          kind: "sandbox",
          targetId: deletion.targetId,
          status: completed ? "completed" : blocked ? "blocked" : "processing",
        },
      });
    }
    return send(501, { ok: false, code: "provider_error" });
  }
}
