import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
  readdir,
  chmod,
  link,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nativeBuildOwnershipSchema, nativeSnapshotArtifactSchema } from "@sealant/validators";
import { afterEach, describe, expect, it, vi } from "vitest";

import { boatErrorEnvelope, type FakeBoatRefusal } from "../../../boat-harness/fake-boat.js";
import { BOAT_REFUSALS } from "../../../boat-harness/refusals.js";
import { HttpBoatApi, boatBuildOwnershipLabels } from "../../runtime/boat/api.js";
import { BoatSecret, BoatBuildOwnership } from "../../runtime/boat/config.js";
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
    await readdir(directory);
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
      sealantctl: NATIVE_RUNTIME_PIN.sealantctl,
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
  let createRefusal: FakeBoatRefusal | undefined;
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
  let deletionAccepted = false;
  let delayDelete = false;
  let finishDelete: (() => void) | undefined;
  const deletionReceived = Promise.withResolvers<void>();
  let snapshotReadFailure: "html" | "unexpected-code" | "wrong-resource" | undefined;
  let inventory: Array<{ id: string; state: string; labels: Record<string, string> }> = [];
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
      if (request.url?.startsWith("/api/v1/sandboxes?")) {
        respond(response, {
          ok: true,
          sandboxes: inventory,
          pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
        });
      } else if (request.url === "/api/v1/sandboxes" && request.method === "POST") {
        const saved: unknown = JSON.parse(requireJournal());
        expect(saved).toMatchObject({
          allocation: { state: "intent", key: journal.allocation.key },
        });
        if (failCreateOnce) {
          failCreateOnce = false;
          response.destroy();
          return;
        }
        if (createRefusal !== undefined) {
          respond(response, boatErrorEnvelope(createRefusal), createRefusal.status);
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
      } else if (request.url === "/api/v1/sandboxes/" + id && request.method === "GET") {
        if (deletionAccepted) {
          respond(response, { ok: false, code: "not_found" }, 404);
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
      } else if (request.url === "/api/v1/sandboxes/" + id && request.method === "DELETE") {
        expect(JSON.parse(requireJournal())).toMatchObject({
          allocation: { state: "deleting", id },
        });
        deletionAccepted = true;
        const send = () =>
          respond(response, {
            ok: true,
            operation: { id: operation, targetId: id, kind: "sandbox", status: "pending" },
          });
        if (delayDelete) {
          finishDelete = send;
          deletionReceived.resolve();
        } else send();
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
        } else if (snapshotReadFailure === "html") {
          response.writeHead(404, { "content-type": "text/html" }).end("<html>Not found</html>");
        } else if (snapshotReadFailure !== undefined) {
          respond(
            response,
            {
              ok: false,
              code:
                snapshotReadFailure === "wrong-resource" ? "sandbox_not_found" : "unknown_route",
            },
            404,
          );
        } else if (snapshot !== undefined) respond(response, { ok: true, snapshot });
        else respond(response, { ok: false, code: "not_found" }, 404);
      } else respond(response, { ok: false, code: "not_found" }, 404);
    });
  });
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
    api: parsed.value,
    directory,
    path,
    journal,
    identity,
    requests,
    inventory: (entries: typeof inventory) => {
      inventory = entries;
    },
    loseCreate: () => {
      failCreateOnce = true;
    },
    refuseCreate: (refusal: FakeBoatRefusal) => {
      createRefusal = refusal;
    },
    snapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    failSnapshotRead: (value: typeof snapshotReadFailure) => {
      snapshotReadFailure = value;
    },
    holdDelete: () => {
      delayDelete = true;
    },
    deletionReceived: deletionReceived.promise,
    hideSandbox: () => {
      deletionAccepted = true;
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
  it("cleans a historical runtime identity without current-pin reuse authority or invented probe", async () => {
    const f = await fixture();
    await f.write({
      ...f.journal,
      runtime: {
        ...f.journal.runtime,
        source: f.journal.runtime.source.replace("next.180", "next.100"),
        manifest: "d".repeat(64),
        sealantd: "e".repeat(64),
      },
      allocation: { ...f.journal.allocation, state: "known", id },
    });
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(await f.read()).toMatchObject({
      phase: "complete",
      runtime: { manifest: "d".repeat(64) },
    });
    expect(await f.read()).not.toHaveProperty("evidence");
  });

  it("rejects traversal and symlink journals without provider work", async () => {
    const f = await fixture();
    const alias = join(f.directory, randomUUID() + ".json");
    await symlink(f.path, alias);
    expect(await f.builder.cleanup(alias)).toMatchObject({ ok: false });
    expect(await f.builder.cleanup(join(f.directory, "..", "unowned.json"))).toMatchObject({
      ok: false,
      error: { code: "native-invalid-journal-path" },
    });
    const inventory = await f.builder.journals({ limit: 10 });
    expect(inventory).toMatchObject({
      ok: true,
      value: {
        entries: [{ buildId: f.journal.build }],
        failures: [{ name: alias.slice(f.directory.length + 1) }],
      },
    });
    expect(f.requests).toEqual([]);
  });
  it("rejects noncanonical paths, public files, hard links and an aliased root", async () => {
    const f = await fixture();
    expect(
      await f.builder.cleanup(
        f.directory + "/../" + f.directory.split("/").at(-1) + "/" + f.journal.build + ".json",
      ),
    ).toMatchObject({ ok: false, error: { code: "native-invalid-journal-path" } });
    await chmod(f.path, 0o644);
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-unsafe-journal" },
    });
    await chmod(f.path, 0o600);
    const hardLink = join(f.directory, randomUUID() + ".json");
    await link(f.path, hardLink);
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-unsafe-journal" },
    });
    const alias = join(f.directory, "alias");
    await symlink(f.directory, alias);
    const builder = new BoatSnapshotBuilder({ api: f.api, owner, journalDirectory: alias });
    expect(await builder.journals({ limit: 10 })).toMatchObject({
      ok: false,
      error: { code: "native-unsafe-journal-directory" },
    });
    expect(f.requests).toEqual([]);
  });
  it("continues bounded inventory past an invalid basename without reading outside the root", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "!invalid"), "untrusted", { mode: 0o600 });
    expect(await f.builder.journals({ limit: 1 })).toMatchObject({
      ok: true,
      value: {
        next: "!invalid",
        entries: [],
        failures: [{ name: "!invalid", error: { code: "native-invalid-journal-path" } }],
      },
    });
    expect(await f.builder.journals({ limit: 1, after: "!invalid" })).toMatchObject({
      ok: true,
      value: { entries: [{ buildId: f.journal.build }], failures: [] },
    });
    expect(await f.builder.journals({ limit: 1, after: "../unowned" })).toMatchObject({
      ok: false,
      error: { code: "native-invalid-journal-page" },
    });
    expect(f.requests).toEqual([]);
  });
  it("keeps missing sandboxes unresolved without a validated deletion intent", async () => {
    const f = await fixture();
    await f.write({ ...f.journal, allocation: { ...f.journal.allocation, state: "known", id } });
    f.hideSandbox();
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { code: "native-provider-not_found" },
    });
    expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("polls deletion operations recorded by earlier known-state journals", async () => {
    const f = await fixture();
    await f.write({
      ...f.journal,
      allocation: { ...f.journal.allocation, state: "known", id, deletion: operation },
    });
    f.hideSandbox();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(await f.read()).toMatchObject({
      phase: "complete",
      allocation: { state: "deleted", deletion: operation },
    });
    expect(
      f.requests.every((r) => r.method === "GET" && r.path.includes("deletion-operations")),
    ).toBe(true);
  });

  it("bounds a lost deletion response and leaves an exact retryable obligation", async () => {
    const f = await fixture(40);
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    let cleanupDeadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === 40 ? cleanupDeadline.signal : nativeTimeout(ms)));
    resources.push(async () => {
      cleanupDeadline.abort();
      timeout.mockRestore();
    });
    f.holdDelete();
    const cleanup = f.builder.cleanup(f.path);
    await f.deletionReceived;
    cleanupDeadline.abort();
    expect(await cleanup).toMatchObject({
      ok: false,
      error: { code: "native-interrupted" },
    });
    expect(await f.read()).toMatchObject({
      phase: "running",
      allocation: { state: "deleting", id },
    });
    cleanupDeadline = new AbortController();
    f.releaseDelete();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    expect(await f.read()).toMatchObject({
      phase: "complete",
      allocation: { state: "deleted", id, deletion: operation },
    });
    expect(f.requests.filter((r) => r.method === "GET" && r.path.endsWith(id))).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "DELETE" && r.path.endsWith(id))).toHaveLength(2);
    expect(timeout.mock.calls.filter(([ms]) => ms === 40)).toHaveLength(2);
  });

  it("reconciles a lost allocation response with exactly the recorded key and confirms deletion", async () => {
    const f = await fixture();
    f.loseCreate();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    const creates = f.requests.filter((r) => r.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.key).toBe(f.journal.allocation.key);
    expect(creates[0]?.body).toEqual({
      type: "small",
      ttlSeconds: 900,
      noEnv: true,
      monitoring: false,
      labels: { "sealant-dev": "boat-stream", "sealant-build": f.journal.build },
    });
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

  it("ends on a refusal no retry can change, with Boat's reason, and creates once (SLNT-782)", async () => {
    const f = await fixture();
    f.refuseCreate(BOAT_REFUSALS["key-expired"]);
    const result = await f.builder.cleanup(f.path);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "native-provider-api_key_expired",
        providerFailure: {
          operation: "create",
          status: 403,
          boat: { kind: "key-expired", code: "api_key_expired", retryable: false },
        },
      },
    });
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    if (!result.ok) expect(result.error.message).not.toContain("boat_test_credential");
  });

  it("retries a create Boat could not serve yet, under the same key", async () => {
    const f = await fixture();
    f.refuseCreate(BOAT_REFUSALS["no-machine"]);
    expect(await f.builder.cleanup(f.path)).toMatchObject({
      ok: false,
      error: { providerFailure: { boat: { kind: "no-machine", retryAfterSeconds: 5 } } },
    });
    const creates = f.requests.filter((r) => r.method === "POST");
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((r) => r.key))).toEqual(new Set([f.journal.allocation.key]));
  });

  it("replays the private snapshot policy recorded by a newer allocation intent", async () => {
    const f = await fixture();
    await f.write({
      ...f.journal,
      allocation: { ...f.journal.allocation, requestVersion: 2 },
    });
    f.loseCreate();
    expect(await f.builder.cleanup(f.path)).toEqual({ ok: true, value: undefined });
    const creates = f.requests.filter((r) => r.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body).toEqual({
      type: "small",
      ttlSeconds: 900,
      noEnv: true,
      monitoring: false,
      snapshots: true,
      visibility: "private",
      labels: { "sealant-dev": "boat-stream", "sealant-build": f.journal.build },
    });
    expect(creates[1]).toEqual(creates[0]);
    expect(await f.read()).toMatchObject({
      phase: "complete",
      allocation: { state: "deleted", requestVersion: 2 },
    });
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

  it.each(["unknown", "duplicate"] as const)(
    "keeps an expired version 3 create %s without reissuing or saving",
    async (mode) => {
      const f = await fixture();
      const ownership = nativeBuildOwnershipSchema.parse({
        publicationId: randomUUID(),
        buildId: f.journal.build,
        key: {
          deploymentId: "local-stage2a",
          scope: { kind: "owner", ownerUserId: "usr_stage2a" },
          recipeHash: f.journal.recipeHash,
          runtime: f.journal.runtime,
          assetsHash: "d".repeat(64),
          platform: "linux/amd64",
        },
      });
      const parsed = BoatBuildOwnership.parse({ owner, reservation: ownership });
      if (!parsed.ok) throw parsed.error;
      if (mode === "duplicate") {
        const labels = boatBuildOwnershipLabels(parsed.value);
        f.inventory([
          { id, state: "ready", labels },
          { id: "bx_3456789a", state: "ready", labels },
        ]);
      }
      await f.write({
        ...f.journal,
        ownership,
        allocation: {
          ...f.journal.allocation,
          requestVersion: 3,
          requestedAt: "2020-01-01T00:00:00.000Z",
        },
      });
      expect(await f.builder.reconcileBuild(ownership)).toMatchObject({
        ok: false,
        error: {
          code:
            mode === "duplicate"
              ? "native-allocation-conflict"
              : "native-idempotency-window-expired",
        },
      });
      expect(f.requests.length).toBeGreaterThan(0);
      expect(
        f.requests.every(
          (request) => request.method === "GET" && request.path.startsWith("/api/v1/sandboxes?"),
        ),
      ).toBe(true);
      expect(await f.read()).toMatchObject({
        allocation: { state: "intent", requestVersion: 3 },
        save: { state: "none" },
      });
    },
  );

  it.each(["name", "sourceSandboxId", "createdAt", "snapshotId"] as const)(
    "never deletes a snapshot with replaced %s after scratch cleanup",
    async (field) => {
      const f = await fixture();
      const save = {
        state: "known",
        ...f.identity,
        requestedAt: f.identity.createdAt,
        identity: f.identity,
      };
      await f.write({ ...f.journal, save });
      const replacements = {
        name: "unrelated-snapshot",
        sourceSandboxId: "bx_87654322",
        createdAt: "2020-01-01T00:00:00.000Z",
        snapshotId: "unrelated",
      };
      f.snapshot({ ...f.identity, [field]: replacements[field], status: "ready" });
      expect(await f.builder.cleanup(f.path)).toMatchObject({
        ok: false,
        error: { code: "native-snapshot-identity-mismatch" },
      });
      expect(f.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
        "/api/v1/sandboxes/" + id,
      ]);
    },
  );

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

  for (const failure of ["html", "unexpected-code", "wrong-resource"] as const)
    it(`keeps ${failure} snapshot 404 unresolved until a valid provider observation`, async () => {
      const f = await fixture();
      const artifact = nativeSnapshotArtifactSchema.parse({
        kind: "boat-saved-snapshot",
        owner,
        build: f.journal.build,
        recipeHash: f.journal.recipeHash,
        receiptHash: "e".repeat(64),
        runtime: f.journal.runtime,
        identity: f.identity,
      });
      await f.write({
        ...f.journal,
        phase: "published",
        receiptHash: artifact.receiptHash,
        allocation: { ...f.journal.allocation, state: "deleted", id, deletion: operation },
        save: {
          state: "known",
          name: f.identity.name,
          sourceSandboxId: id,
          requestedAt: f.identity.createdAt,
          identity: f.identity,
        },
      });
      f.failSnapshotRead(failure);
      const code =
        failure === "html"
          ? "invalid_response"
          : failure === "wrong-resource"
            ? "sandbox_not_found"
            : // Boat's own code, not a catch-all.
              "unknown_route";
      expect(await f.builder.remove(artifact)).toMatchObject({
        ok: false,
        error: { code: `native-provider-${code}` },
      });
      expect(await f.read()).not.toHaveProperty("removal");
      expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);

      const observations = f.requests.length;
      f.failSnapshotRead(undefined);
      f.snapshot({ ...f.identity, status: "ready" });
      expect(await f.builder.remove(artifact)).toEqual({ ok: true, value: "deleted" });
      expect(f.requests.length).toBeGreaterThan(observations);
      expect(await f.read()).toMatchObject({ phase: "published", removal: "complete" });
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
