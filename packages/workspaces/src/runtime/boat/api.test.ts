import http from "node:http";
import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { HttpBoatApi } from "./api.js";
import {
  BoatSecret,
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
        ttlSeconds: 600,
      }),
    ).toMatchObject({ ok: true });
    expect(body).toEqual({
      type: "small",
      ttlSeconds: 600,
      noEnv: true,
      monitoring: false,
      labels: { "sealant-dev": "boat-stream", "sealant-build": marker },
    });
    expect(await api.create({ marker, idempotencyKey: marker, ttlSeconds: 1801 })).toMatchObject({
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
    const input = { marker, idempotencyKey: marker };
    const first = must(await api.create(input));
    const second = must(await api.create(input));
    expect(first).toEqual({ id, state: "ready" });
    expect(second).toEqual(first);
    expect(requests).toEqual(
      [0, 1].map(() => ({
        key: marker,
        body: {
          type: "small",
          ttlSeconds: 900,
          noEnv: true,
          monitoring: false,
          labels: { "sealant-dev": "boat-stream", "sealant-spike": marker },
        },
      })),
    );
  });

  it("preserves archived as provider state rather than writer exclusion", async () => {
    const api = await server((_request, response) =>
      respond(response, { ok: true, sandbox: { id, state: "archived" } }),
    );
    expect(must(await api.get(id))).toEqual({ id, state: "archived" });
  });

  it("keeps hosted and file credentials at their final I/O boundary and resumes with no account environment", async () => {
    const requests: Array<{ path: string | undefined; body: unknown }> = [];
    const secret = must(BoatSecret.parse("b".repeat(64)));
    const api = await server((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        respond(
          response,
          request.url?.endsWith("/host")
            ? {
                ok: true,
                isProtected: true,
                url: `https://test-8080.on.boat.dev/?_token=${"a".repeat(64)}`,
              }
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
    must(await api.resume(id));
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
      { path: `/api/v1/sandboxes/${id}/resume`, body: { ttlSeconds: 900, noEnv: true } },
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
