import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { getWorkspaceOp, resolveInternalConfig, sealantApiClientLayer } from "./effect/index.js";
import {
  opencode,
  Sealant,
  SealantApiError,
  SealantBudgetExceededError,
  SealantError,
  type RequestPriority,
  type SealantConfig,
} from "./index.js";

const now = "2026-11-05T00:00:00.000Z";
const details = {
  workspaceId: "ws_1",
  name: "test",
  ownerUserId: "alice",
  status: "ready",
  createdAt: now,
  updatedAt: now,
  spec: { harness: { id: "codex" } },
};
const sessionWire = {
  sessionId: "ses_1",
  workspaceId: "ws_1",
  runId: "run_1",
  ownerUserId: "alice",
  status: "running",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  outputHighWater: "0",
  createdAt: now,
};
const budget = (marker = true) => ({
  _tag: "BudgetExceededError",
  message: "request allowance reached",
  budget: "serviceOwnerRequestsPerMinute",
  limit: 4,
  retryAfterSeconds: 37,
  ...(marker ? { refusal: { phase: "before-work", bucket: "owner" } } : {}),
});
const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(status === 429 ? { "retry-after": "37" } : {}),
  });
  response.end(JSON.stringify(body));
};

const serve = async (
  options: {
    legacy?: boolean;
    downstream?: boolean;
    afterCreate?: boolean;
    afterStop?: boolean;
    afterWorkspaceCreate?: boolean;
    success?: boolean;
  } = {},
  config: Pick<SealantConfig, "requestPriority"> = {},
) => {
  const received: { path: string; priority: string | string[] | undefined; body: unknown }[] = [];
  const record = async (request: IncomingMessage) => {
    const bytes: Buffer[] = [];
    for await (const bytesPart of request) bytes.push(Buffer.from(bytesPart));
    const text = Buffer.concat(bytes).toString();
    const body: unknown =
      text === ""
        ? undefined
        : request.headers["content-type"] === "application/octet-stream"
          ? text
          : JSON.parse(text);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    received.push({ path, priority: request.headers["x-sealant-request-priority"], body });
    return path;
  };
  const server = createServer((request, response) => {
    void record(request)
      .then((path) => {
        if (options.afterWorkspaceCreate && path === "/v1/workspaces")
          return json(
            response,
            {
              workspaceId: "ws_1",
              name: "test",
              status: "queued",
              registryId: "default",
              repository: "fixture",
              tag: "latest",
            },
            202,
          );
        if (options.afterStop && path === "/v1/workspaces/ws_1/stop")
          return json(response, { workspaceId: "ws_1", status: "running" }, 202);
        if (path === "/v1/workspaces/ws_1") {
          if (
            options.afterWorkspaceCreate ||
            (options.afterStop && received.some((r) => r.path.endsWith("/stop")))
          )
            return json(response, budget(), 429);
          return json(response, details);
        }
        if (path === "/v1/sessions/ses_1") return json(response, sessionWire);
        if (options.success) {
          if (path === "/v1/sessions/ses_1/output/stream") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end("event: output\nid: 1\ndata: aGk=\n\nevent: end\ndata: {}\n\n");
            return;
          }
          if (path.endsWith("/exec"))
            return json(response, {
              exitCode: 0,
              stdout: "done",
              stderr: "",
              truncated: false,
              timedOut: false,
            });
          if (path.endsWith("/forward/v2")) return json(response, {}, 426);
          if (path.endsWith("/input") || path.endsWith("/signal") || path.endsWith("/resize"))
            return json(response, { ok: true });
        }
        if (options.afterCreate && path === "/v1/runs")
          return json(
            response,
            {
              runId: "run_1",
              workspaceId: "ws_1",
              ownerUserId: "alice",
              harnessId: "codex",
              mode: "one-shot",
              status: "completed",
              createdAt: now,
              updatedAt: now,
            },
            201,
          );
        if (options.downstream)
          return json(
            response,
            { _tag: "SessionConflictError", message: "daemon refused input" },
            409,
          );
        return json(response, budget(options.legacy !== true), 429);
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new Sealant({
    baseUrl,
    apiKey: "key",
    ownerUserId: "alice",
    ...config,
  });
  return {
    baseUrl,
    client,
    received,
    close: async () => {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
};

const caught = async (effect: Promise<unknown>): Promise<unknown> => {
  try {
    await effect;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
};

describe("public SDK request budget failures over HTTP", () => {
  it("session send preserves typed 429 metadata, sets interactive priority and does not retry", async () => {
    const s = await serve();
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      const error = await caught(session.send("hello"));
      expect(error).toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toBeInstanceOf(SealantApiError);
      expect(error).toMatchObject({
        status: 429,
        code: "BudgetExceededError",
        budget: "serviceOwnerRequestsPerMinute",
        limit: 4,
        retryAfterSeconds: 37,
        refusal: { phase: "before-work", bucket: "owner" },
      });
      expect(s.received.map((r) => [r.path, r.priority])).toEqual([
        ["/v1/workspaces/ws_1", "normal"],
        ["/v1/sessions/ses_1", "normal"],
        ["/v1/sessions/ses_1/input", "interactive"],
      ]);
      expect(s.received.at(-1)?.body).toEqual({ ownerUserId: "alice", dataBase64: "aGVsbG8=" });
      await Promise.all([session.signal(2).catch(() => undefined), session.status()]);
      expect(s.received.slice(3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/v1/sessions/ses_1/signal", priority: "interactive" }),
          expect.objectContaining({ path: "/v1/sessions/ses_1", priority: "normal" }),
        ]),
      );
    } finally {
      await s.close();
    }
  });

  it("decodes old servers' budget errors without claiming pre-work refusal", async () => {
    const s = await serve({ legacy: true });
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const error = await caught(workspace.stop());
      expect(error).toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 37, refusal: undefined });
      expect(s.received.at(-1)?.priority).toBe("interactive");
    } finally {
      await s.close();
    }
  });

  it("keeps downstream failures distinct from admission refusals", async () => {
    const s = await serve({ downstream: true });
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      const error = await caught(session.send("hello"));
      expect(error).toBeInstanceOf(SealantApiError);
      expect(error).not.toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toMatchObject({ code: "SessionConflictError" });
      expect(error).not.toHaveProperty("refusal");
    } finally {
      await s.close();
    }
  });

  it("does not turn an SSE refusal into immediate polling traffic", async () => {
    const s = await serve();
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      const error = await caught(session.output()[Symbol.asyncIterator]().next());
      expect(error).toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toMatchObject({ retryAfterSeconds: 37 });
      expect(s.received.map((r) => r.path)).toEqual([
        "/v1/workspaces/ws_1",
        "/v1/sessions/ses_1",
        "/v1/sessions/ses_1/output/stream",
      ]);
    } finally {
      await s.close();
    }
  });

  it("raw resource exec preserves the same refusal fields and sends its priority", async () => {
    const s = await serve();
    try {
      const scope = s.client.scopes.actAs("rdm:project");
      const error = await caught(
        scope.instances.exec("db", {
          argv: ["cat"],
          stdin: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("stdin"));
              c.close();
            },
          }),
        }),
      );
      expect(error).toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toMatchObject({
        retryAfterSeconds: 37,
        refusal: { phase: "before-work", bucket: "owner" },
      });
      expect(s.received).toHaveLength(1);
      expect(s.received[0]?.priority).toBe("normal");
      expect(s.received[0]?.body).toBe('{"argv":["cat"],"user":null,"timeoutMs":600000}\nstdin');
    } finally {
      await s.close();
    }
  });

  it("keeps the completed workspace create and stop visible when later observation is refused", async () => {
    const created = await serve({ afterWorkspaceCreate: true });
    try {
      const error = await caught(
        created.client.workspaces.create({
          repository: "github.com/sealant-sh/fixture",
          harness: opencode(),
        }),
      );
      expect(error).toMatchObject({
        code: "workspace_readiness_refused",
        cause: { retryAfterSeconds: 37 },
      });
      expect(error).not.toHaveProperty("refusal");
    } finally {
      await created.close();
    }
    const stopped = await serve({ afterStop: true });
    try {
      const workspace = await stopped.client.workspaces.get("ws_1");
      const error = await caught(workspace.stop());
      expect(error).toMatchObject({
        code: "workspace_stop_observation_refused",
        cause: { retryAfterSeconds: 37 },
      });
      expect(error).not.toHaveProperty("refusal");
    } finally {
      await stopped.close();
    }
  });

  it("wraps a follow-up refusal after creating a run with context about the completed write", async () => {
    const s = await serve({ afterCreate: true });
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const error = await caught(workspace.harness.run("hello"));
      expect(error).toBeInstanceOf(SealantError);
      expect(error).not.toBeInstanceOf(SealantBudgetExceededError);
      expect(error).toMatchObject({
        code: "run_followup_refused",
        cause: { status: 429, retryAfterSeconds: 37 },
      });
      expect(error).not.toHaveProperty("refusal");
      expect(s.received.filter((r) => r.path === "/v1/runs")).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});

describe("public SDK dispatch-time request priority", () => {
  it("uses the current workflow priority on a retained session without caching the provider result", async () => {
    const workflow = new AsyncLocalStorage<RequestPriority>();
    let calls = 0;
    const s = await serve(
      {},
      {
        requestPriority: () => {
          calls++;
          return workflow.getStore() ?? "normal";
        },
      },
    );
    try {
      expect(calls).toBe(0);
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      expect(calls).toBe(2);
      await session.status();
      await workflow.run("interactive", () => session.status());
      await session.status();
      expect(calls).toBe(5);
      expect(s.received.map((r) => r.priority)).toEqual([
        "normal",
        "normal",
        "normal",
        "interactive",
        "normal",
      ]);
    } finally {
      await s.close();
    }
  });

  it.each(["value", "provider"])(
    "explicit normal %s overrides interactive control defaults",
    async (mode) => {
      const s = await serve(
        { success: true },
        {
          requestPriority: mode === "value" ? "normal" : () => "normal",
        },
      );
      try {
        const workspace = await s.client.workspaces.get("ws_1");
        const session = await workspace.sessions.get("ses_1");
        await session.send("hello");
        await session.resize(100, 40);
        await session.signal(2);
        expect(s.received.slice(2).map((r) => [r.path, r.priority])).toEqual([
          ["/v1/sessions/ses_1/input", "normal"],
          ["/v1/sessions/ses_1/resize", "normal"],
          ["/v1/sessions/ses_1/signal", "normal"],
        ]);
      } finally {
        await s.close();
      }
    },
  );

  it("evaluates an Effect client's provider when an already-created operation runs", async () => {
    const s = await serve();
    let priority: RequestPriority = "normal";
    let calls = 0;
    const config = resolveInternalConfig({
      baseUrl: s.baseUrl,
      requestPriority: () => {
        calls++;
        return priority;
      },
    });
    const layer = sealantApiClientLayer(config);
    const operation = getWorkspaceOp("ws_1");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          expect(calls).toBe(0);
          yield* operation;
          priority = "interactive";
          yield* operation;
          priority = "normal";
          yield* operation;
        }).pipe(Effect.provide(layer)),
      );
      expect(calls).toBe(3);
      expect(s.received.map((r) => r.priority)).toEqual(["normal", "interactive", "normal"]);
    } finally {
      await s.close();
    }
  });

  it("resolves SSE priority at iteration and again for every later stream", async () => {
    let priority: RequestPriority = "normal";
    let calls = 0;
    const s = await serve(
      { success: true },
      {
        requestPriority: () => {
          calls++;
          return priority;
        },
      },
    );
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      const capturedOutput = session.output();
      expect(calls).toBe(2);
      for (const current of ["interactive", "normal"] satisfies RequestPriority[]) {
        priority = current;
        const output = current === "interactive" ? capturedOutput : session.output();
        const chunks = [];
        for await (const chunk of output) chunks.push(chunk);
        expect(chunks).toEqual([{ sequence: 1n, data: new TextEncoder().encode("hi") }]);
      }
      expect(calls).toBe(4);
      expect(s.received.slice(2).map((r) => [r.path, r.priority])).toEqual([
        ["/v1/sessions/ses_1/output/stream", "interactive"],
        ["/v1/sessions/ses_1/output/stream", "normal"],
      ]);
    } finally {
      await s.close();
    }
  });

  it("resolves raw resource exec priority for each dispatch through a retained scope", async () => {
    const workflow = new AsyncLocalStorage<RequestPriority>();
    const s = await serve(
      { success: true },
      {
        requestPriority: () => workflow.getStore() ?? "normal",
      },
    );
    try {
      const scope = s.client.scopes.actAs("rdm:project");
      const exec = () => scope.instances.exec("db", { argv: ["true"] });
      expect(await exec()).toMatchObject({ exitCode: 0, stdout: "done" });
      expect(await workflow.run("interactive", exec)).toMatchObject({ exitCode: 0 });
      expect(await exec()).toMatchObject({ exitCode: 0 });
      expect(s.received.map((r) => r.priority)).toEqual(["normal", "interactive", "normal"]);
    } finally {
      await s.close();
    }
  });

  it("resolves priority for each forward HTTP probe through a retained workspace", async () => {
    const workflow = new AsyncLocalStorage<RequestPriority>();
    const s = await serve(
      { success: true },
      {
        requestPriority: () => workflow.getStore() ?? "normal",
      },
    );
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const open = () => caught(workspace.forward(3000, { flow: "bounded" }));
      expect(await open()).toMatchObject({ reason: "transport-unavailable" });
      expect(await workflow.run("interactive", open)).toMatchObject({
        reason: "transport-unavailable",
      });
      expect(await open()).toMatchObject({ reason: "transport-unavailable" });
      expect(s.received.slice(1).map((r) => [r.path, r.priority])).toEqual([
        ["/v1/workspaces/ws_1/forward/v2", undefined],
        ["/v1/workspaces/ws_1/forward/v2", "normal"],
        ["/v1/workspaces/ws_1/forward/v2", undefined],
        ["/v1/workspaces/ws_1/forward/v2", "interactive"],
        ["/v1/workspaces/ws_1/forward/v2", undefined],
        ["/v1/workspaces/ws_1/forward/v2", "normal"],
      ]);
    } finally {
      await s.close();
    }
  });

  it("keeps provider exceptions as failed requests without polling or budget classification", async () => {
    const failure = new Error("priority provider failed");
    let throwing = false;
    const s = await serve(
      { success: true },
      {
        requestPriority: () => {
          if (throwing) throw failure;
          return "normal";
        },
      },
    );
    try {
      const workspace = await s.client.workspaces.get("ws_1");
      const session = await workspace.sessions.get("ses_1");
      throwing = true;
      const requestError = await caught(session.status());
      expect(requestError).toBeInstanceOf(SealantError);
      expect(requestError).not.toBeInstanceOf(SealantBudgetExceededError);
      expect(requestError).toMatchObject({ cause: failure });
      expect(await caught(session.output()[Symbol.asyncIterator]().next())).toBe(failure);
      expect(
        await caught(s.client.scopes.actAs("rdm:project").instances.exec("db", { argv: ["true"] })),
      ).toBe(failure);
      expect(s.received).toHaveLength(2);
      expect(await caught(workspace.forward(3000, { flow: "bounded" }))).toBe(failure);
      expect(s.received.slice(2).map((r) => r.priority)).toEqual([undefined]);
      throwing = false;
      await session.status();
      expect(s.received.at(-1)?.priority).toBe("normal");
    } finally {
      await s.close();
    }
  });

  it("keeps provider exceptions as defects for Effect-native callers", async () => {
    const s = await serve();
    const failure = new Error("priority provider failed");
    const layer = sealantApiClientLayer(
      resolveInternalConfig({
        baseUrl: s.baseUrl,
        requestPriority: () => {
          throw failure;
        },
      }),
    );
    try {
      const exit = await Effect.runPromiseExit(getWorkspaceOp("ws_1").pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure);
      expect(s.received).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
