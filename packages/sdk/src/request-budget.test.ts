import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError, SealantBudgetExceededError, SealantError } from "./errors.js";
import { opencode } from "./harness.js";

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
  } = {},
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
  const client = new Sealant({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "key",
    ownerUserId: "alice",
  });
  return {
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
