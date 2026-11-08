import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { opencode, Sealant, type CreateOptions } from "./index.js";

const serve = async (refused = false) => {
  const received: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(refused ? 503 : 202, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          refused
            ? {
                _tag: "WorkspaceServiceUnavailableError",
                message: "Boat execution is not available on this deployment.",
                code: "boat-production-capability-unverified",
              }
            : {
                workspaceId: "ws_runtime",
                name: "runtime test",
                status: "queued",
                registryId: "default",
                repository: "fixture",
                tag: "latest",
              },
        ),
      );
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Sealant({ baseUrl: `http://127.0.0.1:${address.port}` });
  return {
    client,
    received,
    close: async () => {
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
};

describe("explicit workspace runtime", () => {
  it.each(["docker", "boat", "k8s", "k3s", "cloudflare", "microvm"] as const)(
    "requires %s over real HTTP",
    async (runtime) => {
      const f = await serve();
      try {
        await f.client.workspaces.create({ ...options, runtime });
        expect(f.received).toEqual([
          expect.objectContaining({
            spec: expect.objectContaining({
              target: expect.objectContaining({ runtime: { family: runtime, mode: "require" } }),
            }),
          }),
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it("keeps the deployment default when no runtime is selected", async () => {
    const f = await serve();
    try {
      await f.client.workspaces.create(options);
      expect(f.received).toEqual([
        expect.objectContaining({
          spec: expect.objectContaining({
            target: expect.objectContaining({ runtime: { family: "auto", mode: "prefer" } }),
          }),
        }),
      ]);
    } finally {
      await f.close();
    }
  });

  it("returns a Boat admission refusal without a second create or fallback", async () => {
    const f = await serve(true);
    try {
      await expect(
        f.client.workspaces.create({ ...options, runtime: "boat" }),
      ).rejects.toMatchObject({
        code: "WorkspaceServiceUnavailableError",
        reason: "boat-production-capability-unverified",
      });
      expect(f.received).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("refuses an unknown runtime before sending a request", async () => {
    const f = await serve();
    try {
      await expect(
        // @ts-expect-error Unknown runtime families are also refused for JavaScript callers.
        f.client.workspaces.create({ ...options, runtime: "unsupported" }),
      ).rejects.toMatchObject({ code: "invalid_create_options" });
      expect(f.received).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
