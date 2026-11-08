import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, copyFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { BoatSecret } from "../runtime/boat/config.js";
import {
  boatProofConfigSchema,
  MendProofClient,
  runBoatLiveCheck,
  type ProofRuntime,
} from "./boat-live-check.js";
import { BoatProofProvider } from "./boat-proof-provider.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});
const listen = async (server: net.Server) => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture port");
  disposals.push(() => new Promise<void>((done) => server.close(() => done())));
  return address.port;
};
const fixture = async (
  options: { corruptResume?: boolean; holdCleanup?: boolean; echoOnly?: boolean } = {},
) => {
  const source = await mkdtemp(join(tmpdir(), "boat-check-source-"));
  const child = await mkdtemp(join(tmpdir(), "boat-check-child-"));
  disposals.push(
    () => rm(source, { recursive: true, force: true }),
    () => rm(child, { recursive: true, force: true }),
  );
  const reach = net.createServer((socket) => socket.end());
  const port = await listen(reach);
  let generation = 0;
  let projectId = "project_test";
  let name = "";
  const publicationId = randomUUID();
  const runtimes = new Map<string, ProofRuntime>();
  let idleStoppedAt: string | null = null;
  let captured = "";
  let withdrawn = false;
  const routes: string[] = [];
  const events: Readonly<Record<string, unknown>>[] = [];
  const session = () => ({
    id: "session_test",
    projectId,
    name,
    worktreeId: "worktree_test",
    sealantRunId: generation === 0 ? null : `run_${generation}`,
    idleStoppedAt,
  });
  const setRuntime = (closed: boolean) =>
    runtimes.set(`run_${generation}`, {
      runId: `run_${generation}`,
      sandboxId: generation === 1 ? "bx_23456789" : "bx_3456789a",
      publicationId,
      resourceSubnet: "127.0.0.0/27",
      ready: !closed,
      closed,
    });
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== "Bearer synthetic-mend-token") {
        response.writeHead(401);
        response.end();
        return;
      }
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      routes.push(`${request.method} ${path}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown =
        chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown = {};
      if (path === "/api/projects/project_test/sessions") {
        const { z } = await import("zod");
        const payload = z.object({ name: z.string(), harness: z.literal("codex") }).parse(body);
        name = payload.name;
        projectId = "project_test";
        result = session();
      } else if (path === "/api/sessions/session_test/launch") {
        generation = 1;
        setRuntime(false);
      } else if (path === "/api/sessions/session_test") result = { session: session() };
      else if (path === "/api/sessions") result = [session()];
      else if (path === "/api/sessions/session_test/resume") {
        generation = 2;
        idleStoppedAt = null;
        setRuntime(false);
        for (const file of await readdir(source))
          await copyFile(join(source, file), join(child, file));
        if (options.corruptResume)
          for (const file of await readdir(child)) await rm(join(child, file));
      } else if (path === "/api/sessions/session_test/shell")
        result = { id: `process_${generation}` };
      else if (path === "/api/upgrade-tickets") result = { ticket: "synthetic-single-use-ticket" };
      else if (path.startsWith("/api/processes/")) {
        if (generation === 1) {
          idleStoppedAt = new Date().toISOString();
          setRuntime(true);
          const file = (await readdir(source))[0];
          if (file !== undefined) captured = await readFile(join(source, file), "utf8");
        }
      } else if (path.includes("/raw")) {
        response.end(captured);
        return;
      } else if (path === "/api/sessions/session_test/stop") {
        if (!options.holdCleanup) setRuntime(true);
      } else {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.searchParams.get("ticket") !== "synthetic-single-use-ticket") {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data, binary) => {
        if (!binary) return;
        if (options.echoOnly) {
          client.send(data, { binary: true });
          client.send(JSON.stringify({ t: "end" }));
          return;
        }
        const command = spawn("sh", ["-c", data.toString()], {
          cwd: generation === 1 ? source : child,
          stdio: ["ignore", "pipe", "ignore"],
        });
        command.stdout.on("data", (bytes: Buffer) => client.send(bytes, { binary: true }));
        command.on("close", () => client.send(JSON.stringify({ t: "end" })));
      });
    });
  });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  disposals.push(() => new Promise<void>((done) => ws.close(() => done())));
  const config = boatProofConfigSchema.parse({
    origin,
    projectId,
    ownerId: "usr_test",
    deploymentId: "test",
    resourceHost: "localhost",
    resourcePort: port,
  });
  return {
    config,
    routes,
    events,
    runtimes,
    publicationId,
    source,
    child,
    run: () =>
      runBoatLiveCheck(config, new MendProofClient(origin, "synthetic-mend-token"), {
        record: (event) => events.push(event),
        runtime: async (s) => (s.sealantRunId === null ? undefined : runtimes.get(s.sealantRunId)),
        inventory: async () => ({
          sandboxes: [...runtimes.values()].filter((r) => !r.closed).map((r) => r.sandboxId),
          snapshots: generation > 0 && !withdrawn ? ["proof-snapshot"] : [],
          pages: 1,
        }),
        privacy: async () => ({ conclusion: "fixture-only" }),
        withdraw: async () => {
          if ([...runtimes.values()].some((r) => !r.closed)) throw new Error("live pin");
          withdrawn = true;
        },
      }),
  };
};

describe("operator checker against Mend HTTP and terminal protocol", () => {
  it("executes its emitted shell, observes actual idle Stop, reads captured edits and verifies a fresh child", async () => {
    const f = await fixture();
    await f.run();
    expect(f.routes.filter((r) => r.endsWith("/launch"))).toHaveLength(1);
    expect(f.routes.filter((r) => r.endsWith("/resume"))).toHaveLength(1);
    expect(f.routes.filter((r) => r.endsWith("/shell"))).toHaveLength(2);
    expect(f.events).toContainEqual(expect.objectContaining({ event: "idle-stopped" }));
    expect(f.events).toContainEqual(
      expect.objectContaining({ event: "resumed-edits-intact", sandboxId: "bx_3456789a" }),
    );
    expect(f.events.at(-1)).toMatchObject({
      event: "final-inventory",
      sandboxes: [],
      snapshots: [],
    });
  });
  it("refuses lost resumed bytes, then closes only its session and removes its publication", async () => {
    const f = await fixture({ corruptResume: true });
    await expect(f.run()).rejects.toThrow("shell-proof-missing");
    expect(f.events.some((e) => e.event === "resumed-edits-intact")).toBe(false);
    expect(f.events.at(-1)).toMatchObject({
      event: "final-inventory",
      sandboxes: [],
      snapshots: [],
    });
  });
  it("terminal echo cannot forge the marker", async () => {
    const f = await fixture({ echoOnly: true });
    await expect(f.run()).rejects.toThrow("shell-proof-missing");
  });
});

it("records complete inventory pages and negative-auth privacy without trusting absent visibility", async () => {
  const auth: string[] = [];
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization ?? "none";
    auth.push(authorization);
    if (authorization !== "Bearer synthetic-boat-key-0000") {
      response.writeHead(401);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://fixture");
    response.setHeader("content-type", "application/json");
    const body = url.pathname.endsWith("/sandboxes")
      ? {
          ok: true,
          sandboxes: url.searchParams.has("cursor") ? [] : [{ id: "bx_23456789" }],
          pageInfo: {
            nextCursor: url.searchParams.has("cursor") ? null : "second",
            hasMore: !url.searchParams.has("cursor"),
            limit: 200,
          },
        }
      : url.pathname.endsWith("/saved-snapshots")
        ? { ok: true, snapshots: [{ name: "proof" }] }
        : { ok: true, snapshot: {} };
    response.end(JSON.stringify(body));
  });
  const secret = BoatSecret.parse("synthetic-boat-key-0000");
  if (!secret.ok) throw secret.error;
  const provider = new BoatProofProvider(
    secret.value,
    `http://127.0.0.1:${await listen(server)}/api/v1`,
  );
  expect(await provider.inventory()).toEqual({
    sandboxes: ["bx_23456789"],
    snapshots: ["proof"],
    pages: 2,
  });
  const privacy = await provider.privacy("proof");
  expect(privacy.observations).toHaveLength(4);
  expect(privacy.observations.every((o) => o.result === "refused")).toBe(true);
  expect(privacy.apiVisibility).toEqual({});
  expect(privacy.conclusion).toContain("cross-account privacy unknown");
  expect(auth.filter((a) => a === "none")).toHaveLength(2);
});
