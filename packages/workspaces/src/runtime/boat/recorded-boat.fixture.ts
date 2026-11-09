/**
 * A fake Boat control plane that behaves as recorded, not as convenient. Facts it keeps
 * (docs/experiments/boat-provider-lifetime-evidence.json, boat-runtime.md, api.test.ts):
 *
 * - Create needs an `Idempotency-Key`, answers 202 with the VM in `provisioned`, and replays the
 *   same VM for the same key. Reads then move it through `cloning` to `idle`.
 * - Discovery is a paginated label query with `pageInfo`.
 * - DELETE needs `X-Ascii-Confirm-Delete: <id>` and answers with a deletion operation that is
 *   `pending`, then `processing`, then `completed` as it is polled. Only completion removes the VM.
 * - A VM Boat does not have is a typed 404 `sandbox_not_found`.
 * - Commands run as uid 1000; this fake runs no commands and refuses them, so no test can pass by
 *   pretending a guest answered.
 *
 * Faults are explicit switches named for what they inject.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

import { z } from "zod";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const sandboxId = () =>
  `bx_${Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;

interface Vm {
  readonly id: string;
  readonly key: string;
  readonly labels: Record<string, string>;
  state: "provisioned" | "cloning" | "idle";
}
interface Deletion {
  readonly id: string;
  readonly targetId: string;
  polls: number;
}

export class RecordedBoat {
  readonly vms = new Map<string, Vm>();
  readonly deletions = new Map<string, Deletion>();
  readonly requests: string[] = [];
  /** Fault: Boat accepted create but cannot read the VM yet (eventually consistent read). */
  unreadableAfterCreate = 0;
  /** Fault: the create reply is lost after Boat accepted it. */
  loseCreateReply = false;
  /** Fault: the DELETE reply is lost after Boat accepted and completed it. */
  loseDeleteReply = false;
  /** Fault: every request fails at the transport. */
  unreachable = false;
  /** How many polls a deletion takes to complete. */
  deletionPolls = 2;
  #server: http.Server | undefined;

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

  #view(vm: Vm) {
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
    if (this.unreachable) {
      response.destroy();
      return;
    }
    let raw = "";
    for await (const part of request) raw += String(part);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (request.method === "POST" && path === "/sandboxes") {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") return send(400, { ok: false, code: "invalid_request" });
      const body = z
        .object({ labels: z.record(z.string(), z.string()) })
        .passthrough()
        .parse(JSON.parse(raw));
      const existing = [...this.vms.values()].find((vm) => vm.key === key);
      const vm = existing ?? { id: sandboxId(), key, labels: body.labels, state: "provisioned" };
      this.vms.set(vm.id, vm);
      if (this.loseCreateReply) {
        response.destroy();
        return;
      }
      return send(202, { ok: true, sandbox: this.#view(vm) });
    }
    if (request.method === "GET" && path === "/sandboxes") {
      const wanted = url.searchParams.getAll("label").map((pair) => pair.split("="));
      const sandboxes = [...this.vms.values()]
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
      const vm = this.vms.get(sandbox[1] ?? "");
      if (vm === undefined || this.unreadableAfterCreate > 0) {
        if (vm !== undefined) this.unreadableAfterCreate -= 1;
        return send(404, { ok: false, code: "sandbox_not_found" });
      }
      const view = this.#view(vm);
      vm.state = vm.state === "provisioned" ? "cloning" : "idle";
      return send(200, { ok: true, sandbox: view });
    }
    if (sandbox !== null && request.method === "DELETE") {
      const id = sandbox[1] ?? "";
      if (request.headers["x-ascii-confirm-delete"] !== id)
        return send(400, { ok: false, code: "invalid_request" });
      if (!this.vms.has(id)) return send(404, { ok: false, code: "sandbox_not_found" });
      const deletion = {
        id: `bdop_${randomUUID().replaceAll("-", "")}`,
        targetId: id,
        polls: 0,
      };
      this.deletions.set(deletion.id, deletion);
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
    const operation = /^\/deletion-operations\/(bdop_[a-f0-9]{32})$/.exec(path);
    if (operation !== null && request.method === "GET") {
      const deletion = this.deletions.get(operation[1] ?? "");
      if (deletion === undefined) return send(404, { ok: false, code: "not_found" });
      deletion.polls += 1;
      const completed = deletion.polls >= this.deletionPolls;
      if (completed) this.vms.delete(deletion.targetId);
      return send(200, {
        ok: true,
        operation: {
          id: deletion.id,
          kind: "sandbox",
          targetId: deletion.targetId,
          status: completed ? "completed" : "processing",
        },
      });
    }
    return send(501, { ok: false, code: "provider_error" });
  }
}
