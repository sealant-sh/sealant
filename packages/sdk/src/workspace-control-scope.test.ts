/**
 * An executor's control scope over real HTTP (SLNT-1332): what `create()` sends to name it and to
 * ask for the caller's channels in it, what is refused before any request, and where the scope
 * comes back (the launch, a standby claim, a recovery).
 */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { opencode, Sealant, type CreateOptions } from "./index.js";

const WORKSPACE_ID = "ws_scope";
const OWNER = "usr_owner";
const SCOPE = "mend-exec-1";

const runtime = {
  adapter: "host-vm",
  resourceId: "sealant-vm-run_1",
  reference: "sealant-vm-run_1",
  status: "running",
  deadline: null,
  runId: "run_1",
  controlScope: SCOPE,
};

const answer = (method: string, path: string): { status: number; body: unknown } => {
  if (method === "POST" && path === "/v1/workspaces") {
    return {
      status: 202,
      body: {
        workspaceId: WORKSPACE_ID,
        name: "scope test",
        status: "queued",
        registryId: "default",
        repository: "fixture",
        tag: "latest",
        runId: "run_1",
        controlScope: SCOPE,
        runtime,
      },
    };
  }
  if (method === "POST" && path === `/v1/workspaces/${WORKSPACE_ID}/capture/replan`) {
    return {
      status: 200,
      body: {
        worktreeId: "wt_1",
        epoch: 2,
        filesWritten: 0,
        bytesWritten: 0,
        filesSkipped: 0,
        bytesSkipped: 0,
        removed: 0,
        unchanged: false,
        controlScope: SCOPE,
      },
    };
  }
  if (method === "POST" && path === `/v1/workspaces/${WORKSPACE_ID}/recover`) {
    return {
      status: 202,
      body: {
        workspaceId: WORKSPACE_ID,
        state: "requested",
        recoverable: true,
        controlScope: SCOPE,
      },
    };
  }
  return { status: 404, body: { _tag: "WorkspaceNotFoundError", message: "no route" } };
};

const serve = async () => {
  const received: Array<{ readonly url: string; readonly body: unknown }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const url = request.url ?? "";
      received.push({ url, body: text.length === 0 ? undefined : JSON.parse(text) });
      const { status, body } = answer(request.method ?? "", url.split("?")[0] ?? "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Sealant({ baseUrl: `http://127.0.0.1:${address.port}`, ownerUserId: OWNER });
  return {
    client,
    received,
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        }),
      );
    },
  };
};

const options: CreateOptions = {
  repository: "github.com/acme/app",
  harness: opencode(),
  wait: false,
  controlScope: SCOPE,
  executorSockets: { capture: true, session: true },
};

describe("workspaces.create with a control scope", () => {
  it("names the scope beside the spec and asks for the channels in it", async () => {
    await using f = await serve();
    await f.client.workspaces.create(options);
    expect(f.received[0]?.body).toMatchObject({
      controlScope: SCOPE,
      spec: { runtime: { executorSockets: { capture: true, session: true } } },
    });
  });

  it("asks for no channel when none is wanted", async () => {
    await using f = await serve();
    await f.client.workspaces.create({ ...options, executorSockets: { capture: false } });
    const body = f.received[0]?.body;
    expect(JSON.stringify(body)).not.toContain("executorSockets");
  });

  it.each(["../mend", "Mend", "sealant-run-1"])(
    "refuses the scope %s before any request",
    async (controlScope) => {
      await using f = await serve();
      await expect(f.client.workspaces.create({ ...options, controlScope })).rejects.toMatchObject({
        code: "invalid_create_options",
      });
      expect(f.received).toEqual([]);
    },
  );

  it("reports the scope on the launch, a standby claim and a recovery", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create(options);
    expect(workspace.launch?.controlScope).toBe(SCOPE);
    expect(workspace.launch?.runtime?.controlScope).toBe(SCOPE);
    expect((await workspace.capture.replan()).controlScope).toBe(SCOPE);
    expect(await workspace.recover()).toEqual({
      state: "requested",
      recoverable: true,
      controlScope: SCOPE,
    });
  });
});
