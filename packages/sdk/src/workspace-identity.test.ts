/**
 * What a caller needs to record the executor it launched and find it again: the idempotency key
 * on `create()` (a repeated create answers with the first workspace), `findByIdempotencyKey()`
 * after a lost answer, `workspace.runtime()` and `workspace.launch` for the executor's
 * `resourceId`, and the executor on `captureDrain`. Driven through the real client against a
 * scripted `fetch` (no live API).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { opencode } from "./index.js";

const RUNTIME = {
  adapter: "docker",
  resourceId: "container-1",
  reference: "sealant-run_1",
  status: "ready",
  deadline: null,
  runId: "run_1",
};

const details = (status: string, extra: Record<string, unknown> = {}) => ({
  workspaceId: "ws_1",
  name: "t",
  ownerUserId: "local",
  status,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  ...extra,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The wire client reads the global fetch once, when its layer is first built: install one
// fetch for the whole file and point it at each test's script.
let answer: (url: URL, method: string, body: unknown) => Response = () => json({}, 500);
let recorded: Array<{ method: string; url: URL; body: unknown }> = [];
beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const body: unknown = text.length === 0 ? undefined : JSON.parse(text);
    recorded.push({ method: request.method, url, body });
    return answer(url, request.method, body);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const scripted = (script: (url: URL, method: string, body: unknown) => Response) => {
  answer = script;
  recorded = [];
  return { requests: recorded, sealant: new Sealant({ baseUrl: "http://stub.invalid" }) };
};

describe("workspaces.create({ idempotencyKey }) and the executor's identity", () => {
  it("sends the key, and records the run and the executor that became ready", async () => {
    const { sealant, requests } = scripted((url, method) =>
      method === "POST"
        ? json(
            {
              workspaceId: "ws_1",
              name: "t",
              status: "queued",
              registryId: "default",
              repository: "r",
              tag: "t",
              runId: "run_1",
            },
            202,
          )
        : json(details("ready", { runtime: RUNTIME })),
    );

    const workspace = await sealant.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      idempotencyKey: "mend-exec-7",
    });

    expect(requests[0]?.body).toMatchObject({ idempotencyKey: "mend-exec-7" });
    expect(workspace.launch).toEqual({
      replayed: false,
      runId: "run_1",
      runtime: {
        kind: "docker",
        resourceId: "container-1",
        reference: "sealant-run_1",
        status: "ready",
        runId: "run_1",
        deadline: null,
      },
    });
  });

  it("reports a replayed create with the executor the first one started", async () => {
    const { sealant } = scripted(() =>
      json(
        {
          workspaceId: "ws_1",
          name: "t",
          status: "ready",
          registryId: "default",
          repository: "r",
          tag: "t",
          runId: "run_1",
          runtime: RUNTIME,
          replayed: true,
        },
        202,
      ),
    );
    const workspace = await sealant.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      idempotencyKey: "mend-exec-7",
      wait: false,
    });
    expect(workspace.id).toBe("ws_1");
    expect(workspace.launch).toMatchObject({
      replayed: true,
      runId: "run_1",
      runtime: { resourceId: "container-1" },
    });
  });

  it("finds the workspace a create with the key made, or null", async () => {
    const { sealant, requests } = scripted((url) =>
      json({
        items:
          url.searchParams.get("idempotencyKey") === "mend-exec-7"
            ? [details("ready", { runtime: RUNTIME })]
            : [],
      }),
    );
    const found = await sealant.workspaces.findByIdempotencyKey("mend-exec-7");
    expect(found?.id).toBe("ws_1");
    expect(requests[0]?.url.searchParams.get("idempotencyKey")).toBe("mend-exec-7");
    expect(await sealant.workspaces.findByIdempotencyKey("other")).toBeNull();
  });

  it("reads the current executor, or null before one is launched", async () => {
    let launched = false;
    const { sealant } = scripted(() =>
      json(launched ? details("ready", { runtime: RUNTIME }) : details("queued")),
    );
    const workspace = await sealant.workspaces.get("ws_1");
    expect(await workspace.runtime()).toBeNull();
    launched = true;
    expect(await workspace.runtime()).toEqual({
      kind: "docker",
      resourceId: "container-1",
      reference: "sealant-run_1",
      status: "ready",
      runId: "run_1",
      deadline: null,
    });
    expect(workspace.launch).toBeUndefined();
  });
});

describe("workspaces.createState() / cancelCreate() and the launch identity (review 3 #21, decision 5)", () => {
  it("reads what became of a create by its key, precisely", async () => {
    const { sealant, requests } = scripted(() =>
      json({ idempotencyKey: "key_1", state: "pending", launchId: "key_1" }),
    );
    await expect(sealant.workspaces.createState("key_1")).resolves.toEqual({
      idempotencyKey: "key_1",
      state: "pending",
      launchId: "key_1",
    });
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.pathname).toBe("/v1/workspaces/idempotency-keys/key_1");
  });

  it("fails on an answer it does not understand, never reads it as none", async () => {
    const { sealant } = scripted(() => json({ idempotencyKey: "key_1", state: "gone" }));
    await expect(sealant.workspaces.createState("key_1")).rejects.toThrow();
  });

  it("cancels a create by its key", async () => {
    const { sealant, requests } = scripted(() =>
      json({ idempotencyKey: "key_1", state: "cancelled" }),
    );
    await expect(sealant.workspaces.cancelCreate("key_1")).resolves.toEqual({
      idempotencyKey: "key_1",
      state: "cancelled",
    });
    expect(requests[0]).toMatchObject({ method: "POST" });
    expect(requests[0]?.url.pathname).toBe("/v1/workspaces/idempotency-keys/key_1/cancel");
    expect(requests[0]?.body).toMatchObject({ ownerUserId: expect.any(String) });
  });

  it("sends the launch id with the create and reports it with the executor", async () => {
    const { sealant, requests } = scripted((_url, method) =>
      method === "POST"
        ? json(
            {
              workspaceId: "ws_1",
              name: "t",
              status: "queued",
              registryId: "default",
              repository: "r",
              tag: "t",
              runId: "run_1",
              launchId: "launch_1",
            },
            202,
          )
        : json(details("ready", { runtime: { ...RUNTIME, launchId: "launch_1" } })),
    );
    const workspace = await sealant.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      idempotencyKey: "launch_1",
      launchId: "launch_1",
    });
    expect(requests[0]?.body).toMatchObject({ idempotencyKey: "launch_1", launchId: "launch_1" });
    expect(workspace.launch).toMatchObject({ launchId: "launch_1" });
    await expect(workspace.runtime()).resolves.toMatchObject({ launchId: "launch_1" });
  });
});
