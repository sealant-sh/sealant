import http from "node:http";
import { inspect } from "node:util";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { HttpBoatApi, type BoatCreateInput } from "./api.js";
import {
  BoatSecret,
  BoatOwnership,
  parseBoatLifetime,
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatResult,
} from "./config.js";
import { boatControlConnection, parseBoatHostedControl } from "./connection.js";

const must = <T>(result: BoatResult<T>): T => {
  if (!result.ok) throw result.error;
  return result.value;
};
const id = boatSandboxIdSchema.parse("bx_23456789");
const deletionId = boatDeletionIdSchema.parse(`bdop_${"a".repeat(32)}`);
const marker = "07dc2f0c-6bef-4c88-91f5-65da969c5346";
const ownershipInput = {
  deploymentId: "deployment-a",
  workspaceId: "workspace-a",
  runId: "run-a",
  runtimeInstanceId: "instance-a",
  launchAttemptId: "attempt-a",
  sourceId: "boat-snapshot:source-a",
};
const ownership = must(BoatOwnership.parse(ownershipInput));
const productionLabels = {
  "sealant-runtime": "boat",
  "sealant-deployment": "deployment-a",
  "sealant-workspace": "workspace-a",
  "sealant-run": "run-a",
  "sealant-instance": "instance-a",
  "sealant-attempt": "attempt-a",
  "sealant-source": "boat-snapshot:source-a",
};
const credential = must(BoatSecret.parse("boat_test_credential_0123456789"));
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
const server = async (handler: http.RequestListener) => {
  const listener = http.createServer(handler);
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  close.push(async () => {
    listener.closeAllConnections();
    await new Promise<void>((done, failed) =>
      listener.close((error) => {
        if (error) {
          failed(error);
          return;
        }
        done();
      }),
    );
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return must(
    HttpBoatApi.create({
      credential,
      baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      timeoutMs: 1000,
    }),
  );
};
const respond = (response: http.ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
};

const page = (sandboxes: readonly unknown[], nextCursor: string | null = null) => ({
  ok: true,
  sandboxes,
  pageInfo: { nextCursor, hasMore: nextCursor !== null, limit: 200 },
});

describe("Boat ownership and lifetime inputs", () => {
  it("copies and freezes validated identity, keeping each field and label within provider limits", () => {
    const input = { ...ownershipInput };
    const identity = must(BoatOwnership.parse(input));
    input.deploymentId = "other";
    expect(identity).toEqual(ownershipInput);
    expect(Object.isFrozen(identity)).toBe(true);
    expectTypeOf<typeof ownershipInput>().not.toExtend<BoatOwnership>();
    expectTypeOf<{
      lifetime: { kind: "production-session" };
      idempotencyKey: string;
      marker: string;
    }>().not.toExtend<BoatCreateInput>();
    for (const key of Object.keys(ownershipInput)) {
      for (const invalid of [undefined, "", "a\nsecret", "a".repeat(257), "é".repeat(129)])
        expect(BoatOwnership.parse({ ...ownershipInput, [key]: invalid }).ok).toBe(false);
      expect(BoatOwnership.parse({ ...ownershipInput, [key]: "é".repeat(128) }).ok).toBe(true);
    }
  });

  it("accepts only an explicit production choice or a bounded integer TTL with its short default", () => {
    expect(must(parseBoatLifetime({ kind: "production-session" }))).toBeNull();
    expect(must(parseBoatLifetime({ kind: "bounded" }))).toBe(900);
    for (const ttlSeconds of [60, 600, 1800])
      expect(must(parseBoatLifetime({ kind: "bounded", ttlSeconds }))).toBe(ttlSeconds);
    for (const input of [
      undefined,
      null,
      {},
      { kind: "unknown" },
      { kind: "production-session", ttlSeconds: 900 },
      ...[null, 59, 1801, 900.5, "900", Infinity, NaN].map((ttlSeconds) => ({
        kind: "bounded",
        ttlSeconds,
      })),
    ])
      expect(parseBoatLifetime(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_lifetime" },
      });
  });
});

describe("Boat production lifetime at the HTTP boundary", () => {
  it("creates a private session and resumes with exact null TTL, leaving idle observations live", async () => {
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      key: string | string[] | undefined;
      body: unknown;
    }> = [];
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          key: request.headers["idempotency-key"],
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
        });
        respond(
          response,
          {
            ok: true,
            sandbox: {
              id,
              state: "idle",
              labels: productionLabels,
              archiveAfter: null,
              ttlSeconds: null,
              snapshots: true,
              monitoring: false,
              dataExpiredAt: null,
              env: { secret: "discard" },
              url: "https://secret.invalid",
            },
          },
          request.method === "POST" ? 202 : 200,
        );
      });
    });
    const input = {
      lifetime: { kind: "production-session" },
      ownership,
      idempotencyKey: marker,
      from: boatSnapshotNameSchema.parse("source-a"),
    } as const;
    const created = must(await api.create(input));
    expect(created).toMatchObject({
      id,
      state: "idle",
      autoStop: { kind: "disabled" },
      archiveAfter: null,
      snapshots: true,
      monitoring: false,
    });
    expect(JSON.stringify(created)).not.toContain("secret");
    expect(must(await api.create(input))).toEqual(created);
    expect(must(await api.resume(id, { kind: "production-session" }))).toEqual(created);
    expect(must(await api.get(id))).toEqual(created);
    const body = {
      type: "small",
      ttlSeconds: null,
      noEnv: true,
    };
    expect(requests).toEqual([
      ...[0, 1].map(() => ({
        method: "POST",
        path: "/api/v1/sandboxes",
        key: marker,
        body: {
          ...body,
          monitoring: false,
          snapshots: true,
          visibility: "private",
          labels: productionLabels,
          from: "source-a",
        },
      })),
      { method: "POST", path: `/api/v1/sandboxes/${id}/resume`, key: undefined, body },
      ...[0, 1].map(() => ({
        method: "GET",
        path: `/api/v1/sandboxes/${id}`,
        key: undefined,
        body: undefined,
      })),
    ]);
  });

  it.each([
    { fields: {}, expected: "unverified" },
    { fields: { ttlSeconds: null }, expected: "unverified" },
    { fields: { archiveAfter: null, ttlSeconds: 900 }, expected: "unverified" },
    { fields: { archiveAfter: "2026-11-05T12:00:00Z", ttlSeconds: null }, expected: "unverified" },
    { fields: { archiveAfter: "2026-11-05T12:00:00Z", ttlSeconds: 900 }, expected: "scheduled" },
    { fields: { archiveAfter: null }, expected: "disabled" },
  ])(
    "reports actual lifetime evidence from create and fresh resume observation: $expected $fields",
    async ({ fields, expected }) => {
      const api = await server((_request, response) =>
        respond(response, { ok: true, sandbox: { id, state: "idle", ...fields } }),
      );
      const created = must(
        await api.create({
          lifetime: { kind: "production-session" },
          ownership,
          idempotencyKey: marker,
        }),
      );
      const resumed = must(await api.resume(id, { kind: "production-session" }));
      expect(created.autoStop.kind).toBe(expected);
      expect(resumed.autoStop.kind).toBe(expected);
      expect(created.id).toBe(id);
    },
  );

  it("preserves disk-retention flags and pending stops without retaining stop diagnostics", async () => {
    const api = await server((_request, response) =>
      respond(response, {
        ok: true,
        sandbox: {
          id,
          state: "idle",
          archiveAfter: null,
          snapshots: false,
          monitoring: true,
          dataExpiredAt: "2026-11-05T01:00:00Z",
          stoppedAt: null,
          stop: { status: "failing", error: "private-command-output" },
        },
      }),
    );
    expect(must(await api.get(id))).toEqual({
      id,
      state: "idle",
      archiveAfter: null,
      autoStop: { kind: "disabled" },
      snapshots: false,
      monitoring: true,
      dataExpiredAt: "2026-11-05T01:00:00Z",
      stoppedAt: null,
      stop: { status: "failing" },
    });
  });

  it.each(["unavailable", "wrong-id"])(
    "does not infer resumed liveness from acceptance when the fresh observation is %s",
    async (mode) => {
      const paths: Array<string | undefined> = [];
      const api = await server((request, response) => {
        paths.push(request.url);
        if (request.method === "POST") respond(response, { ok: true }, 202);
        else if (mode === "unavailable") respond(response, { ok: false, code: "not_found" }, 404);
        else
          respond(response, {
            ok: true,
            sandbox: { id: "bx_3456789a", state: "idle", archiveAfter: null },
          });
      });
      expect(await api.resume(id, { kind: "production-session" })).toMatchObject({
        ok: false,
        error: {
          operation: "get",
          code: mode === "unavailable" ? "not_found" : "invalid_response",
        },
      });
      expect(paths).toEqual([`/api/v1/sandboxes/${id}/resume`, `/api/v1/sandboxes/${id}`]);
    },
  );

  it("preserves a paid-policy refusal without exposing raw messages or retrying with a bounded TTL", async () => {
    const paths: Array<string | undefined> = [];
    const api = await server((request, response) => {
      paths.push(request.url);
      respond(
        response,
        { ok: false, code: "trial_auto_stop_required", message: "boat_private_secret" },
        403,
      );
    });
    for (const result of [
      await api.create({
        lifetime: { kind: "production-session" },
        ownership,
        idempotencyKey: marker,
      }),
      await api.resume(id, { kind: "production-session" }),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { status: 403, code: "trial_auto_stop_required" },
      });
      expect(JSON.stringify(result)).not.toContain("boat_private_secret");
    }
    expect(paths).toEqual(["/api/v1/sandboxes", `/api/v1/sandboxes/${id}/resume`]);
  });

  it("keeps the bounded resume TTL explicit and obtains fresh evidence instead of trusting the acceptance body", async () => {
    let body: unknown;
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "POST") {
          body = JSON.parse(Buffer.concat(chunks).toString());
          respond(response, { ok: true, sandbox: { id, state: "idle", archiveAfter: null } }, 202);
        } else
          respond(response, {
            ok: true,
            sandbox: {
              id,
              state: "provisioning",
              archiveAfter: "2026-11-05T12:00:00Z",
              ttlSeconds: 600,
            },
          });
      });
    });
    expect(must(await api.resume(id, { kind: "bounded", ttlSeconds: 600 }))).toMatchObject({
      state: "provisioning",
      autoStop: { kind: "scheduled" },
    });
    expect(body).toEqual({
      type: "small",
      ttlSeconds: 600,
      noEnv: true,
    });
    expect(await api.resume(id, { kind: "bounded", ttlSeconds: 59 })).toMatchObject({
      ok: false,
      error: { code: "invalid_lifetime" },
    });
  });
});

describe("Boat complete ownership discovery through HTTP", () => {
  const otherId = boatSandboxIdSchema.parse("bx_3456789a");
  const owned = { id, state: "idle", archiveAfter: null, labels: productionLabels };

  it("uses repeated exact-label filters, checks every identity field locally, and follows opaque cursors to completion", async () => {
    const urls: URL[] = [];
    const api = await server((request, response) => {
      expect(request.method).toBe("GET");
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      urls.push(url);
      const cursor = url.searchParams.get("cursor");
      if (cursor === null)
        respond(
          response,
          page(
            Object.keys(productionLabels).map((key) => ({
              ...owned,
              labels: { ...productionLabels, [key]: "false-filter-match" },
            })),
            "opaque+/=one",
          ),
        );
      else if (cursor === "opaque+/=one")
        respond(
          response,
          page(
            [{ ...owned, env: { secret: "discard" }, desktopUrl: "https://secret.invalid" }],
            "opaque two",
          ),
        );
      else respond(response, page([owned]));
    });
    const result = await api.discover(ownership);
    expect(result).toMatchObject({
      kind: "found",
      ownership,
      sandbox: { id, state: "idle", autoStop: { kind: "disabled" } },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "opaque+/=one",
      "opaque two",
    ]);
    for (const url of urls) {
      expect(url.pathname).toBe("/api/v1/sandboxes");
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.getAll("label")).toEqual(
        Object.entries(productionLabels).map(([key, value]) => `${key}=${value}`),
      );
      expect(url.searchParams.has("state")).toBe(false);
    }
  });

  it.each([
    { sandboxes: [] },
    { sandboxes: [{ ...owned, labels: {} }] },
    { sandboxes: [{ ...owned, labels: undefined }] },
  ])("keeps a complete inventory with no positive match unknown", async ({ sandboxes }) => {
    const api = await server((_request, response) => respond(response, page(sandboxes)));
    expect(await api.discover(ownership)).toEqual({
      kind: "unknown",
      reason: "no-positive-evidence",
    });
  });

  it("reports conflicting exact ownership matches only after the final page", async () => {
    let pages = 0;
    const api = await server((_request, response) =>
      respond(response, ++pages === 1 ? page([owned], "next") : page([{ ...owned, id: otherId }])),
    );
    const result = await api.discover(ownership);
    expect(result).toMatchObject({
      kind: "conflict",
      ownership,
      matches: [{ id }, { id: otherId }],
    });
    expect(pages).toBe(2);
  });

  it.each([
    { ok: true, sandboxes: [owned] },
    { ok: true, pageInfo: { nextCursor: null, hasMore: false, limit: 200 } },
    page([{ ...owned, id: "invalid" }]),
    page([{ ...owned, labels: { "sealant-source": 123 } }]),
    { ...page([owned]), pageInfo: { hasMore: false, limit: 200 } },
    { ...page([owned]), pageInfo: { nextCursor: null, hasMore: true, limit: 200 } },
    { ...page([owned]), pageInfo: { nextCursor: "next", hasMore: false, limit: 200 } },
    { ...page([owned]), pageInfo: { nextCursor: "", hasMore: true, limit: 200 } },
    { ...page([owned]), pageInfo: { nextCursor: null, hasMore: false, limit: 0 } },
  ])("refuses malformed inventory rather than returning a partial owned match", async (body) => {
    const api = await server((_request, response) => respond(response, body));
    expect(await api.discover(ownership)).toMatchObject({
      kind: "unknown",
      reason: "inventory-unavailable",
      error: { operation: "discover", code: "invalid_response" },
    });
  });

  it("does not return a positive match when pagination repeats a cursor", async () => {
    let pages = 0;
    const api = await server((_request, response) => {
      pages++;
      respond(response, page([owned], "same"));
    });
    expect(await api.discover(ownership)).toMatchObject({
      kind: "unknown",
      reason: "inventory-unavailable",
      error: { code: "repeated_cursor" },
    });
    expect(pages).toBe(2);
  });

  it.each(["denied", "unavailable", "lost", "malformed"])(
    "discards partial matches when a later page is %s",
    async (mode) => {
      let pages = 0;
      const api = await server((_request, response) => {
        if (++pages === 1) respond(response, page([owned], "later"));
        else if (mode === "lost") response.destroy();
        else if (mode === "malformed")
          respond(response, { ok: true, sandboxes: "private-payload" });
        else
          respond(
            response,
            {
              ok: false,
              code: mode === "denied" ? "unauthorized" : "private-payload",
              message: "private-payload",
            },
            mode === "denied" ? 403 : 503,
          );
      });
      const result = await api.discover(ownership);
      expect(result).toMatchObject({ kind: "unknown", reason: "inventory-unavailable" });
      expect(result).not.toHaveProperty("matches");
      expect(result).not.toHaveProperty("sandbox");
      expect(JSON.stringify(result)).not.toContain("private-payload");
      expect(pages).toBe(2);
    },
  );

  it("keeps a lost create unresolved without reissue while allowing an unrelated fresh allocation", async () => {
    const methods: Array<string | undefined> = [];
    const api = await server((request, response) => {
      methods.push(request.method);
      if (methods.length === 1) response.destroy();
      else if (request.method === "GET") respond(response, page([]));
      else respond(response, { ok: true, sandbox: { ...owned, id: otherId } }, 202);
    });
    expect(
      await api.create({
        lifetime: { kind: "production-session" },
        ownership,
        idempotencyKey: marker,
      }),
    ).toMatchObject({ ok: false, error: { code: "transport_error" } });
    expect(await api.discover(ownership)).toEqual({
      kind: "unknown",
      reason: "no-positive-evidence",
    });
    const unrelated = must(
      BoatOwnership.parse({
        ...ownershipInput,
        runId: "run-b",
        runtimeInstanceId: "instance-b",
        launchAttemptId: "attempt-b",
      }),
    );
    expect(
      await api.create({
        lifetime: { kind: "production-session" },
        ownership: unrelated,
        idempotencyKey: "17dc2f0c-6bef-4c88-91f5-65da969c5346",
      }),
    ).toMatchObject({ ok: true });
    expect(methods).toEqual(["POST", "GET", "POST"]);
  });
});

describe("Boat API boundary", () => {
  it("bounds native commands and lets cancellation stop waiting without retrying them", async () => {
    const bodies: unknown[] = [];
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (bodies.length === 1)
          respond(response, { ok: true, exitCode: 0, timedOut: false, stdout: "done", stderr: "" });
      });
    });
    expect(await api.execute(id, "public-install", { timeoutSeconds: 600 })).toMatchObject({
      ok: true,
    });
    expect(await api.execute(id, "invalid", { timeoutSeconds: 601 })).toMatchObject({
      ok: false,
      error: { code: "invalid_timeout" },
    });
    const abort = new AbortController();
    const pending = api.execute(id, "long-install", { timeoutSeconds: 600, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    expect(await pending).toMatchObject({ ok: false, error: { code: "transport_error" } });
    expect(bodies).toEqual([
      { command: "public-install", timeoutSeconds: 600 },
      { command: "long-install", timeoutSeconds: 600 },
    ]);
  });

  it("adds owned native allocation labels while forcing the same small isolated VM policy", async () => {
    let body: unknown;
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString());
        respond(response, { ok: true, sandbox: { id, state: "ready" } });
      });
    });
    expect(
      await api.create({
        marker,
        idempotencyKey: marker,
        purpose: "native-build",
        lifetime: { kind: "bounded", ttlSeconds: 600 },
        requestVersion: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(body).toEqual({
      type: "small",
      ttlSeconds: 600,
      noEnv: true,
      monitoring: false,
      snapshots: true,
      visibility: "private",
      labels: { "sealant-dev": "boat-stream", "sealant-build": marker },
    });
    expect(
      await api.create({
        marker,
        idempotencyKey: marker,
        lifetime: { kind: "bounded", ttlSeconds: 1801 },
        requestVersion: 2,
      }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("creates one small isolated allocation with stable retry identity and strips provider URLs", async () => {
    const requests: Array<{ key: string | string[] | undefined; body: unknown }> = [];
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          key: request.headers["idempotency-key"],
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        expect(request.headers.authorization).toBe(`Bearer ${credential.reveal()}`);
        respond(
          response,
          {
            ok: true,
            sandbox: {
              id,
              state: "ready",
              url: "https://private.invalid/?secret=do-not-retain",
              env: { secret: "do-not-retain" },
            },
          },
          202,
        );
      });
    });
    const input = {
      marker,
      idempotencyKey: marker,
      lifetime: { kind: "bounded" },
      requestVersion: 2,
    } as const;
    const first = must(await api.create(input));
    const second = must(await api.create(input));
    expect(first).toEqual({ id, state: "ready", autoStop: { kind: "unverified" } });
    expect(second).toEqual(first);
    expect(requests).toEqual(
      [0, 1].map(() => ({
        key: marker,
        body: {
          type: "small",
          ttlSeconds: 900,
          noEnv: true,
          monitoring: false,
          snapshots: true,
          visibility: "private",
          labels: { "sealant-dev": "boat-stream", "sealant-spike": marker },
        },
      })),
    );
  });

  it("preserves archived as provider state rather than writer exclusion", async () => {
    const api = await server((_request, response) =>
      respond(response, { ok: true, sandbox: { id, state: "archived" } }),
    );
    expect(must(await api.get(id))).toEqual({
      id,
      state: "archived",
      autoStop: { kind: "unverified" },
    });
  });

  it("keeps hosted and file credentials at their final I/O boundary and resumes with no account environment", async () => {
    const requests: Array<{ path: string | undefined; body: unknown }> = [];
    const secret = must(BoatSecret.parse("b".repeat(64)));
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          path: request.url,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
        });
        respond(
          response,
          request.url?.endsWith("/host")
            ? {
                ok: true,
                isProtected: true,
                url: `https://test-8080.on.boat.dev/?_token=${"a".repeat(64)}`,
              }
            : request.method === "GET"
              ? { ok: true, sandbox: { id, state: "idle" } }
              : { ok: true },
        );
      });
    });
    const hosted = must(await api.hostControl(id));
    expect(hosted.origin).toBe("https://test-8080.on.boat.dev");
    expect(
      must(await api.writeFile(id, `/home/user/sealant-dev-boat-stream-${marker}/token`, secret)),
    ).toBeUndefined();
    must(await api.stop(id));
    must(await api.resume(id, { kind: "bounded" }));
    expect(requests).toEqual([
      {
        path: `/api/v1/sandboxes/${id}/host`,
        body: { port: 8080, public: false, localhost: false },
      },
      {
        path: `/api/v1/sandboxes/${id}/files`,
        body: {
          path: `/home/user/sealant-dev-boat-stream-${marker}/token`,
          content: secret.reveal(),
          encoding: "utf8",
        },
      },
      { path: `/api/v1/sandboxes/${id}/stop`, body: {} },
      {
        path: `/api/v1/sandboxes/${id}/resume`,
        body: { type: "small", ttlSeconds: 900, noEnv: true },
      },
      { path: `/api/v1/sandboxes/${id}`, body: undefined },
    ]);
  });

  it.each([
    { ok: true, sandbox: { id: "../other", state: "ready" } },
    { ok: true, sandbox: { id, state: "new-provider-state" } },
    { ok: false, sandbox: { id, state: "ready" } },
    { ok: true, sandbox: null },
  ])("refuses malformed or unknown sandbox responses", async (body) => {
    const api = await server((_request, response) => respond(response, body));
    const result = await api.get(id);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        operation: "get",
        status: 200,
        code: "invalid_response",
      });
  });

  it("redacts all untrusted provider diagnostics and preserves only allowlisted codes", async () => {
    let trusted = false;
    const secret = "boat_private_secret_0123456789";
    const api = await server((_request, response) =>
      respond(
        response,
        {
          ok: false,
          code: trusted ? "trial_saved_snapshots_not_allowed" : secret,
          message: secret,
          url: `https://host.on.boat.dev/?_token=${secret}`,
        },
        403,
      ),
    );
    const result = await api.get(id);
    if (result.ok) throw new Error("expected API failure");
    expect(result.error).toMatchObject({ operation: "get", status: 403, code: "provider_error" });
    expect(`${inspect(result.error)}${JSON.stringify(result.error)}`).not.toContain(secret);
    trusted = true;
    const second = await api.saveSnapshot(
      id,
      boatSnapshotNameSchema.parse("sealant-dev-boat-stream-example"),
    );
    if (second.ok) throw new Error("expected trial refusal");
    expect(second.error.code).toBe("trial_saved_snapshots_not_allowed");
  });

  it("refuses redirects without following them with account credentials", async () => {
    const paths: Array<string | undefined> = [];
    const api = await server((request, response) => {
      paths.push(request.url);
      response.writeHead(302, { location: "/leak" }).end();
    });
    const result = await api.get(id);
    expect(paths).toEqual([`/api/v1/sandboxes/${id}`]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("transport_error");
  });

  it("does not forward bytes to an unapproved upload origin or mismatched path", async () => {
    const stage = `/home/user/sealant-dev-boat-stream-${marker}/sealantd`;
    let mode = "origin";
    const paths: Array<string | undefined> = [];
    const api = await server((request, response) => {
      paths.push(request.url);
      respond(response, {
        ok: true,
        url:
          mode === "origin"
            ? "https://attacker.invalid/private?token=secret"
            : "https://host.on.boat.dev/private?token=secret",
        method: "PUT",
        path: mode === "origin" ? stage : `${stage}.other`,
      });
    });
    for (const invalid of ["origin", "path"]) {
      mode = invalid;
      const result = await api.uploadFile(id, stage, Buffer.from("private-bytes"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_provider_url");
    }
    expect(paths).toHaveLength(2);
    const invalid = await api.uploadFile(id, `${stage}/../escape`, Buffer.from("private-bytes"));
    expect(invalid.ok).toBe(false);
    expect(paths).toHaveLength(2);
  });

  it("confirms exact owned deletion and exposes pending, blocked and completed outcomes", async () => {
    let status = "pending";
    const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
    const api = await server((request, response) => {
      requests.push({ method: request.method, path: request.url });
      if (request.method === "DELETE") expect(request.headers["x-ascii-confirm-delete"]).toBe(id);
      respond(response, {
        ok: true,
        operation: { id: deletionId, kind: "sandbox", targetId: id, status },
      });
    });
    expect(must(await api.deleteSandbox(id)).status).toBe("pending");
    for (const next of ["processing", "blocked", "completed"]) {
      status = next;
      expect(must(await api.getDeletion(deletionId)).status).toBe(next);
    }
    expect(requests[0]).toEqual({ method: "DELETE", path: `/api/v1/sandboxes/${id}` });
    status = "unrecognized";
    expect((await api.getDeletion(deletionId)).ok).toBe(false);
  });

  it("parses command output and snapshot metadata without retaining diagnostic extras", async () => {
    const name = boatSnapshotNameSchema.parse("sealant-dev-boat-stream-example");
    const api = await server((request, response) => {
      if (request.url?.endsWith("/commands"))
        respond(response, {
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: "ubuntu",
          stderr: "",
          internal: "discard",
        });
      else if (request.method === "DELETE")
        respond(response, { ok: true, name, status: "deleted" });
      else
        respond(response, {
          ok: true,
          snapshot: {
            name,
            status: "ready",
            sourceSandboxId: id,
            snapshotId: "snap_immutable",
            createdAt: "2026-11-05T00:00:00Z",
            error: "discard",
          },
        });
    });
    expect(must(await api.execute(id, "cat /etc/os-release"))).toMatchObject({
      stdout: "ubuntu",
      exitCode: 0,
    });
    expect(must(await api.getSnapshot(name))).toEqual({
      name,
      status: "ready",
      sourceSandboxId: id,
      snapshotId: "snap_immutable",
      createdAt: "2026-11-05T00:00:00Z",
    });
    expect(must(await api.deleteSnapshot(name))).toBeUndefined();
  });
});

describe("Boat connection credentials", () => {
  const token = "a".repeat(64);
  it("keeps proxy cookies and independent relay bearer out of endpoint URLs and serialization", async () => {
    const access = must(parseBoatHostedControl(`https://sample-8080.on.boat.dev/?_token=${token}`));
    const relay = must(BoatSecret.parse("b".repeat(64)));
    const connection = boatControlConnection(access, relay);
    expect(connection.url).toBe("wss://sample-8080.on.boat.dev/sealant/control");
    expect(JSON.stringify({ access, relay, connection })).not.toContain(token);
    expect(inspect(access)).not.toContain(token);
    expect(`${access.cookie}`).toBe("[REDACTED]");
    expect(await connection.prepare()).toEqual({
      headers: { Cookie: `_port_auth=${token}`, Authorization: `Bearer ${"b".repeat(64)}` },
    });
  });

  it.each([
    "http://sample-8080.on.boat.dev/",
    "https://sample-8080.on.boat.dev.attacker.invalid/",
    "https://on.boat.dev/",
    "https://sample.on.boat.dev:8443/",
    "https://user:pass@sample.on.boat.dev/",
    "https://sample.on.boat.dev/control",
    "https://sample.on.boat.dev/#fragment",
    "https://sample.on.boat.dev/?extra=1",
    "not-a-url",
  ])("rejects an unexpected hosted control URL", (input) => {
    const joiner = input.includes("?") ? "&" : "?";
    expect(parseBoatHostedControl(`${input}${joiner}_token=${token}`).ok).toBe(false);
  });

  it("rejects credentials that could inject a header or cookie", () => {
    for (const value of ["a\r\nX-Leak: yes", `${token}; other=1`, "", undefined])
      expect(BoatSecret.parse(value).ok).toBe(false);
    expect(HttpBoatApi.create({ credential, baseUrl: "https://attacker.invalid/api/v1" }).ok).toBe(
      false,
    );
  });
});
