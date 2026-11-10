import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, copyFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { BoatSecret } from "../runtime/boat/config.js";
import {
  boatProofConfigSchema,
  cleanupBoatLiveCheck,
  MendProofClient,
  runBoatLiveCheck,
  findProofFailure,
  type ProofRuntime,
  type BoatProofServices,
} from "./boat-live-check.js";
import { BoatProofProvider } from "./boat-proof-provider.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
  options: {
    beforeLaunchReply?: () => Promise<void>;
    publicationReady?: () => boolean;
    observeRuntime?: () => void;
    retainedPublication?: boolean;
    unknownSnapshot?: boolean;
    corruptResume?: boolean;
    echoOnly?: boolean;
    malformedCreate?: boolean;
    stopFailure?: boolean;
    listFailure?: boolean;
    initialWorktree?: string;
    extraSessions?: readonly unknown[];
    detailOverrides?: Readonly<Record<string, unknown>>;
    /** Core's rows for a launch that fails before the agent starts, so Mend has no sealantRunId. */
    coreFailure?: {
      readonly attemptStatus: string;
      readonly runtimeStatus: string;
      readonly errorCode: string;
      readonly errorMessage: string;
    };
  } = {},
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
  let name = options.initialWorktree ?? "";
  let sessionStopped = false;
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
    // Contract-derived, not a captured response: Mend main b09a9491 Session has no name.
    worktree: name,
    label: null,
    harness: "codex",
    status: sessionStopped ? "stopped" : generation === 0 ? "starting" : "running",
    worktreeId: "worktree_test",
    sealantRunId:
      generation === 0 || options.coreFailure !== undefined ? null : `run_${generation}`,
    sealantWorkspaceId: generation === 0 ? null : "workspace_test",
    idleStoppedAt,
  });
  const setRuntime = (closed: boolean) => {
    sessionStopped = closed;
    if (generation === 0) return;
    runtimes.set(`run_${generation}`, {
      runId: `run_${generation}`,
      sandboxId: generation === 1 ? "bx_23456789" : "bx_3456789a",
      publicationId,
      resourceSubnet: "127.0.0.0/27",
      ready: !closed && options.coreFailure === undefined,
      closed,
    });
  };
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
        result = options.malformedCreate
          ? { ...session(), sealantRunId: 42, privateData: "synthetic-sensitive-response" }
          : session();
      } else if (path === "/api/sessions/session_test/launch") {
        generation = 1;
        setRuntime(false);
        await options.beforeLaunchReply?.();
      } else if (path === "/api/sessions/session_test")
        result = { session: { ...session(), ...options.detailOverrides } };
      else if (path === "/api/sessions") {
        if (options.listFailure) {
          response.writeHead(503);
          response.end();
          return;
        }
        result = [session(), ...(options.extraSessions ?? [])];
      } else if (path === "/api/sessions/session_test/resume") {
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
        if (options.stopFailure) {
          response.writeHead(503);
          response.end();
          return;
        }
        setRuntime(true);
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
  const mend = new MendProofClient(origin, "synthetic-mend-token");
  const services: BoatProofServices = {
    record: (event) => events.push(event),
    publication: async () =>
      generation === 0
        ? undefined
        : {
            publicationId,
            runId: `run_${generation}`,
            ready: generation === 2 || (options.publicationReady?.() ?? true),
          },
    // The real lookup over Core's rows: workspace, its latest attempt, that attempt's runtime.
    failure: (s) =>
      findProofFailure(s, "usr_test", {
        workspace: async (id) =>
          id === "workspace_test" && generation > 0
            ? { ownerUserId: "usr_test", latestRunId: `run_${generation}` }
            : undefined,
        attempt: async (id) =>
          id === `run_${generation}`
            ? {
                ownerUserId: "usr_test",
                status: options.coreFailure?.attemptStatus ?? "running",
              }
            : undefined,
        runtime: async (runId) =>
          runId === `run_${generation}`
            ? {
                status: options.coreFailure?.runtimeStatus ?? "pending",
                errorCode: options.coreFailure?.errorCode ?? null,
                errorMessage: options.coreFailure?.errorMessage ?? null,
              }
            : undefined,
      }),
    runtime: async (s) => {
      options.observeRuntime?.();
      return s.sealantRunId === null ? undefined : runtimes.get(s.sealantRunId);
    },
    inventory: async () => ({
      sandboxes: [...runtimes.values()].filter((r) => !r.closed).map((r) => r.sandboxId),
      snapshots: [
        ...(options.retainedPublication || (generation > 0 && !withdrawn)
          ? ["proof-snapshot"]
          : []),
        ...(options.unknownSnapshot ? ["unexplained"] : []),
      ],
      ...(options.retainedPublication
        ? { retainedSnapshots: [{ publicationId, name: "proof-snapshot" }] }
        : {}),
      pages: 1,
    }),
    privacy: async () => ({ conclusion: "fixture-only" }),
    withdraw: async () => {
      if ([...runtimes.values()].some((r) => !r.closed)) throw new Error("live pin");
      withdrawn = true;
    },
  };
  return {
    config,
    routes,
    events,
    runtimes,
    publicationId,
    source,
    child,
    run: () => runBoatLiveCheck(config, mend, services),
    cleanup: (previous: readonly Readonly<Record<string, unknown>>[]) =>
      cleanupBoatLiveCheck(config, mend, services, previous),
  };
};

describe("operator checker against Mend HTTP and terminal protocol", () => {
  it("gives native construction its own budget and starts readiness only at publication ready", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const began = Date.now();
    let reads = 0;
    let delayedReadiness = false;
    const reply = Promise.withResolvers<void>();
    const f = await fixture({
      beforeLaunchReply: () => reply.promise,
      publicationReady: () => {
        if (++reads === 1) {
          vi.setSystemTime(began + 13 * 60_000);
          return false;
        }
        reply.resolve();
        return true;
      },
      observeRuntime: () => {
        if (!delayedReadiness && f.events.some((event) => event.event === "publication-ready")) {
          delayedReadiness = true;
          vi.setSystemTime(began + 24 * 60_000);
        }
      },
    });
    try {
      await f.run();
      expect(f.events).toContainEqual(
        expect.objectContaining({ event: "publication-ready", phase: "authenticated-readiness" }),
      );
      expect(f.events).toContainEqual({
        event: "readiness-budget",
        phase: "authenticated-readiness",
        elapsedMs: 11 * 60_000,
      });
    } finally {
      reply.resolve();
    }
  }, 20_000);

  it("stops waiting as soon as Core fails a launch before the agent starts, and reports Core's cause", async () => {
    const cause =
      'Boat runtime: launch-held; diagnostic {"code":"agent-refused","agent":{"reason":"network-binding-conflict"}}';
    const f = await fixture({
      coreFailure: {
        attemptStatus: "failed",
        runtimeStatus: "failed",
        errorCode: "launch-retained",
        errorMessage: cause,
      },
    });
    const began = Date.now();
    await expect(f.run()).rejects.toThrow("authenticated-readiness-core-failed");
    // The readiness budget is twelve minutes; Core's verdict ends the wait on the next poll.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        event: "core-launch-failed",
        phase: "authenticated-readiness",
        errorMessage: cause,
      }),
    );
    expect(f.events.at(-1)).toMatchObject({ event: "final-inventory", sandboxes: [] });
  }, 20_000);

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
  it("permits and records an exactly accounted ready publication without withdrawing it", async () => {
    const f = await fixture({ retainedPublication: true });
    await f.run();
    expect(f.events).toContainEqual({
      event: "publication-retained",
      publication: f.publicationId,
    });
    expect(f.events.at(-1)).toMatchObject({
      event: "final-inventory",
      sandboxes: [],
      snapshots: ["proof-snapshot"],
      retainedSnapshots: [{ publicationId: f.publicationId, name: "proof-snapshot" }],
    });
  });
  it("an accounted ready publication does not excuse an unexplained snapshot", async () => {
    const f = await fixture({ retainedPublication: true, unknownSnapshot: true });
    await expect(f.run()).rejects.toThrow("baseline-not-empty");
    expect(f.routes.some((route) => route.endsWith("/launch"))).toBe(false);
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
  it("records the create ID before rejecting later fields and cleans it without a list lookup", async () => {
    const f = await fixture({ malformedCreate: true, listFailure: true });
    await expect(f.run()).rejects.toThrow("mend-session-response");
    expect(f.events[2]).toMatchObject({ event: "session", id: "session_test" });
    expect(f.events[3]).toEqual({ event: "failed", phase: "mend-session-response" });
    expect(f.routes).toContain("POST /api/sessions/session_test/stop");
    expect(f.routes).not.toContain("GET /api/sessions");
    expect(f.routes.some((r) => r.endsWith("/launch"))).toBe(false);
    expect(f.events.at(-1)).toMatchObject({
      event: "final-inventory",
      sandboxes: [],
      snapshots: [],
    });
    expect(JSON.stringify(f.events)).not.toContain("synthetic-sensitive-response");
  });
  it("reports the first failure together with held cleanup, without exporting response data", async () => {
    const f = await fixture({ malformedCreate: true, stopFailure: true });
    await expect(f.run()).rejects.toMatchObject({
      phase: "mend-session-response",
      cleanupHeld: true,
    });
    expect(f.events).toContainEqual({ event: "failed", phase: "mend-session-response" });
    expect(f.events).toContainEqual({ event: "cleanup-held", operation: "FINAL" });
    expect(JSON.stringify(f.events)).not.toContain("synthetic-sensitive-response");
  });
  it("preserves a shell refusal when FINAL also refuses", async () => {
    const f = await fixture({ echoOnly: true, stopFailure: true });
    await expect(f.run()).rejects.toThrow(/shell-proof-missing; cleanup-held/);
    expect(f.events).toContainEqual({ event: "failed", phase: "shell-proof-missing" });
    expect(f.events).toContainEqual({ event: "cleanup-held", operation: "FINAL" });
  });
  it("recovers the original no-ID journal by exact worktree and closes a starting session with no run", async () => {
    const worktree = "boat-proof-interrupted";
    const f = await fixture({
      initialWorktree: worktree,
      extraSessions: [{ id: "foreign_session", projectId: "other_project", worktree }],
    });
    await f.cleanup([
      { event: "baseline", sandboxes: [], snapshots: [], pages: 1 },
      { event: "create-intent", name: worktree, ...f.config },
      { event: "cleanup-held", operation: "FINAL" },
      { event: "final-inventory", sandboxes: [], snapshots: [], pages: 1 },
    ]);
    expect(f.events).toContainEqual({ event: "session", id: "session_test", name: worktree });
    expect(f.routes).toEqual([
      "GET /api/sessions",
      "GET /api/sessions/session_test",
      "POST /api/sessions/session_test/stop",
      "GET /api/sessions/session_test",
    ]);
    expect(f.events.at(-1)).toMatchObject({
      event: "cleanup-inventory",
      sandboxes: [],
      snapshots: [],
    });
    expect(f.runtimes.size).toBe(0);
  });
  it("uses a saved ID during cleanup after a failed create parse", async () => {
    const f = await fixture({ malformedCreate: true, listFailure: true });
    await expect(f.run()).rejects.toThrow("mend-session-response");
    await f.cleanup([...f.events]);
    expect(f.routes).not.toContain("GET /api/sessions");
    expect(f.events.at(-1)).toMatchObject({
      event: "cleanup-inventory",
      sandboxes: [],
      snapshots: [],
    });
  });
  it.each([
    { id: "different_session" },
    { projectId: "different_project" },
    { worktree: "different_worktree" },
  ])("refuses a changed session target before Stop: %j", async (detailOverrides) => {
    const worktree = "boat-proof-owned";
    const f = await fixture({ initialWorktree: worktree, detailOverrides });
    await expect(
      f.cleanup([
        { event: "create-intent", name: worktree, ...f.config },
        { event: "session", id: "session_test", name: worktree },
      ]),
    ).rejects.toThrow(/session-(identity|ownership)/);
    expect(f.routes.some((r) => r.endsWith("/stop"))).toBe(false);
  });
  it("refuses ambiguous worktree recovery without stopping either session", async () => {
    const worktree = "boat-proof-owned";
    const f = await fixture({
      initialWorktree: worktree,
      extraSessions: [{ id: "other_session", projectId: "project_test", worktree }],
    });
    await expect(
      f.cleanup([{ event: "create-intent", name: worktree, ...f.config }]),
    ).rejects.toThrow("ambiguous-session");
    expect(f.routes).toEqual(["GET /api/sessions"]);
  });
  it("refuses cleanup with changed ledger context before issuing HTTP requests", async () => {
    const f = await fixture();
    await expect(
      f.cleanup([
        { event: "create-intent", name: "boat-proof-owned", ...f.config, ownerId: "another_owner" },
      ]),
    ).rejects.toThrow("ledger-context-mismatch");
    expect(f.routes).toEqual([]);
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
