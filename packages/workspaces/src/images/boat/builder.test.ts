import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpBoatApi } from "../../runtime/boat/api.js";
import { BoatSecret } from "../../runtime/boat/config.js";
import { BoatSnapshotBuilder } from "./builder.js";
import { NATIVE_RUNTIME_PIN } from "./runtime-bundle.js";

const owner = "07dc2f0c-6bef-4c88-91f5-65da969c5346";
const id = "bx_23456789";
const operation = "bdop_" + "a".repeat(32);
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).toReversed()) await close();
});
const respond = (r: http.ServerResponse, value: unknown, status = 200) =>
  r.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

const fixture = async (cleanupTimeoutMs = 1000) => {
  const directory = await mkdtemp(join(tmpdir(), "boat-builder-test-"));
  resources.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const build = randomUUID();
  const name = "sealant-" + owner.slice(0, 8) + "-" + build.replaceAll("-", "");
  const requestedAt = new Date().toISOString();
  const identity = {
    name,
    sourceSandboxId: id,
    createdAt: requestedAt,
    snapshotId: "owned-artifact",
  };
  const journal = {
    version: 1,
    owner,
    build,
    recipeHash: "b".repeat(64),
    runtime: {
      source: NATIVE_RUNTIME_PIN.source,
      platform: "linux/amd64",
      manifest: NATIVE_RUNTIME_PIN.manifest,
      sealantd: NATIVE_RUNTIME_PIN.sealantd,
      socat: NATIVE_RUNTIME_PIN.socat,
      relay: "c".repeat(64),
    },
    phase: "running",
    allocation: { state: "intent", key: randomUUID(), requestedAt },
    save: { state: "none" },
  };
  const path = join(directory, build + ".json");
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const requests: Array<{ method: string; path: string; key?: string | string[]; body: unknown }> =
    [];
  let failCreateOnce = false;
  let snapshot:
    | {
        name: string;
        sourceSandboxId: string;
        createdAt: string;
        snapshotId: string;
        status: string;
      }
    | undefined;
  let deletionPolls = 0;
  let delayDelete = false;
  let finishDelete: (() => void) | undefined;
  const server = http.createServer((request, response) => {
    const data: Buffer[] = [];
    request.on("data", (b: Buffer) => data.push(b));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: data.length ? JSON.parse(Buffer.concat(data).toString()) : undefined,
        ...(request.headers["idempotency-key"] === undefined
          ? {}
          : { key: request.headers["idempotency-key"] }),
      });
      if (request.url === "/api/v1/sandboxes" && request.method === "POST") {
        const saved: unknown = JSON.parse(requireJournal());
        expect(saved).toMatchObject({
          allocation: { state: "intent", key: journal.allocation.key },
        });
        if (failCreateOnce) {
          failCreateOnce = false;
          response.destroy();
          return;
        }
        respond(response, {
          ok: true,
          sandbox: {
            id,
            state: "ready",
            labels: { "sealant-dev": "boat-stream", "sealant-build": build },
          },
        });
      } else if (request.url === "/api/v1/sandboxes/" + id && request.method === "GET")
        respond(response, {
          ok: true,
          sandbox: {
            id,
            state: "ready",
            labels: { "sealant-dev": "boat-stream", "sealant-build": build },
          },
        });
      else if (request.url === "/api/v1/sandboxes/" + id && request.method === "DELETE") {
        const send = () =>
          respond(response, {
            ok: true,
            operation: { id: operation, targetId: id, kind: "sandbox", status: "pending" },
          });
        if (delayDelete) finishDelete = send;
        else send();
      } else if (request.url === "/api/v1/deletion-operations/" + operation)
        respond(response, {
          ok: true,
          operation: {
            id: operation,
            targetId: id,
            kind: "sandbox",
            status: ++deletionPolls > 1 ? "completed" : "processing",
          },
        });
      else if (request.url === "/api/v1/saved-snapshots/" + name) {
        if (request.method === "DELETE") {
          snapshot = undefined;
          respond(response, { ok: true, name, status: "deleted" });
        } else if (snapshot !== undefined) respond(response, { ok: true, snapshot });
        else respond(response, { ok: false, code: "not_found" }, 404);
      } else respond(response, { ok: false, code: "not_found" }, 404);
    });
  });
  // Synchronous observation in the provider verifies fsynced intent precedes mutation.
  const requireJournal = () => readFileSync(path, "utf8");
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  resources.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture has no address");
  const secret = BoatSecret.parse("boat_test_credential_0123456789");
  if (!secret.ok) throw secret.error;
  const parsed = HttpBoatApi.create({
    credential: secret.value,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    timeoutMs: 100,
  });
  if (!parsed.ok) throw parsed.error;
  const builder = new BoatSnapshotBuilder({
    api: parsed.value,
    owner,
    journalDirectory: directory,
    pollIntervalMs: 1,
    cleanupTimeoutMs,
  });
  return {
    builder,
    directory,
    path,
    journal,
    identity,
    requests,
    loseCreate: () => {
      failCreateOnce = true;
    },
    snapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    holdDelete: () => {
      delayDelete = true;
    },
    releaseDelete: () => {
      delayDelete = false;
      finishDelete?.();
    },
    write: async (data: unknown) => writeFile(path, JSON.stringify(data), { mode: 0o600 }),
    read: async (): Promise<unknown> => JSON.parse(await readFile(path, "utf8")),
  };
};

describe("attempt-owned durable native cleanup", () => {
  it("bounds a lost deletion response and leaves an exact retryable obligation", async () => {
    const f = await fixture(40);
    f.holdDelete();
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-interrupted" },
    });
    expect(await f.read()).toMatchObject({ phase: "running", allocation: { state: "known", id } });
    f.releaseDelete();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(await f.read()).toMatchObject({
      phase: "complete",
      allocation: { state: "deleted", id, deletion: operation },
    });
  });

  it("reconciles a lost allocation response with exactly the recorded key and confirms deletion", async () => {
    const f = await fixture();
    f.loseCreate();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    const creates = f.requests.filter((r) => r.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.key).toBe(f.journal.allocation.key);
    expect(creates[1]).toEqual(creates[0]);
    expect(await f.read()).toMatchObject({
      phase: "complete",
      allocation: { state: "deleted", deletion: operation },
    });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const count = f.requests.length;
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(f.requests).toHaveLength(count);
  });

  it("refuses an expired allocation intent without allocating a replacement", async () => {
    const f = await fixture();
    await f.write({
      ...f.journal,
      allocation: { ...f.journal.allocation, requestedAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-idempotency-window-expired" },
    });
    expect(f.requests).toEqual([]);
  });

  it("never deletes a replaced snapshot after scratch cleanup", async () => {
    const f = await fixture();
    const save = {
      state: "known",
      ...f.identity,
      requestedAt: f.identity.createdAt,
      identity: f.identity,
    };
    await f.write({ ...f.journal, save });
    f.snapshot({ ...f.identity, snapshotId: "unrelated", status: "ready" });
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-snapshot-identity-mismatch" },
    });
    expect(f.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
      "/api/v1/sandboxes/" + id,
    ]);
  });

  it("retains ambiguous save intent after 404, then reconciles exactly that name on restart", async () => {
    const f = await fixture();
    await f.write({
      ...f.journal,
      save: { state: "intent", ...f.identity, requestedAt: f.identity.createdAt },
    });
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-save-unresolved" },
    });
    expect(await f.read()).toMatchObject({
      allocation: { state: "deleted" },
      save: { state: "intent" },
    });
    f.snapshot({ ...f.identity, status: "ready" });
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(await f.read()).toMatchObject({ phase: "complete", save: { state: "removed" } });
  });

  it("serializes only the same attempt across kernel locks", async () => {
    const f = await fixture();
    f.holdDelete();
    const first = f.builder.cleanup(f.path);
    for (let i = 0; i < 100 && !f.requests.some((r) => r.method === "DELETE"); i++)
      await new Promise((done) => setTimeout(done, 2));
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-attempt-busy" },
    });
    f.releaseDelete();
    expect(await first).toEqual({ ok: true, value: undefined });
  });
});
