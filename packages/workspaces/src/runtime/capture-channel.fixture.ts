/**
 * A capture session channel for the Docker e2e specs (sealantd ADR-0015's wire): `plan.get`,
 * `upload.urls`, `capture.register`, `lease.heartbeat`, `change.summary`, and object PUT/GET, all
 * in memory, so a real daemon can capture from one executor and restore into the next.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

const planGetRequestSchema = z.looseObject({
  manifest_format: z.number().int().positive().optional(),
  manifest_features: z.array(z.string()).optional(),
});

const uploadUrlsRequestSchema = z.looseObject({
  worktree_id: z.string(),
  epoch: z.number().int().nonnegative(),
  keys: z.array(z.string()),
  sizes: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

const registerRequestSchema = z.looseObject({
  worktree_id: z.string(),
  epoch: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  parent: z.string().nullable(),
  capture_id: z.string(),
  manifest_key: z.string(),
  manifest: z.unknown(),
});

interface CaptureHead {
  readonly n: number;
  readonly capture_id: string;
  readonly manifest_key: string;
  readonly manifest: unknown;
}

export interface CaptureChannelState {
  readonly objects: Map<string, Buffer>;
  readonly errors: Array<unknown>;
  head: CaptureHead | undefined;
  planRequests: number;
}

export interface CaptureChannel {
  readonly endpoint: string;
  readonly state: CaptureChannelState;
  readonly close: () => Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else {
      throw new Error("Capture channel received a non-byte request body.");
    }
  }
  return Buffer.concat(chunks);
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const body = await readBody(request);
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed;
  } catch (cause) {
    throw new Error("Capture channel received invalid JSON.", { cause });
  }
};

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

export const startCaptureChannel = async (options: {
  /** The session credential the daemon must present. */
  readonly token: string;
  /** The worktree every plan answer names. */
  readonly worktreeId: string;
}): Promise<CaptureChannel> => {
  const state: CaptureChannelState = {
    objects: new Map(),
    errors: [],
    head: undefined,
    planRequests: 0,
  };
  let endpoint: string | undefined;

  const objectUrl = (key: string): string => {
    if (endpoint === undefined) {
      throw new Error("Capture channel URL requested before the server started.");
    }
    return `${endpoint}/objects/${Buffer.from(key).toString("base64url")}`;
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://capture-channel.invalid");
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${options.token}` && !url.pathname.startsWith("/objects/")) {
      writeJson(response, 401, { reason: "unauthorized" });
      return;
    }

    if (url.pathname.startsWith("/objects/")) {
      const encodedKey = url.pathname.slice("/objects/".length);
      const key = Buffer.from(encodedKey, "base64url").toString("utf8");
      if (request.method === "PUT") {
        state.objects.set(key, await readBody(request));
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const object = state.objects.get(key);
        if (object === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(object);
        return;
      }
      response.writeHead(405);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    switch (url.pathname) {
      case "/plan.get": {
        state.planRequests += 1;
        // An in-memory store keeps every object as shipped, so it reads every manifest feature and
        // section format the daemon does: answered as asked. A daemon refuses to admit user code
        // over a store that reads less than it writes.
        const asked = planGetRequestSchema.parse(await readJsonBody(request));
        const getUrls = Object.fromEntries(
          Array.from(state.objects.keys(), (key) => [key, objectUrl(key)] as const),
        );
        writeJson(response, 200, {
          worktree_id: options.worktreeId,
          epoch: 1,
          head: state.head ?? null,
          get_urls: getUrls,
          ...(asked.manifest_format === undefined
            ? {}
            : { manifest_format: asked.manifest_format }),
          ...(asked.manifest_features === undefined
            ? {}
            : { manifest_features: asked.manifest_features }),
        });
        return;
      }
      case "/upload.urls": {
        const parsed = uploadUrlsRequestSchema.parse(await readJsonBody(request));
        writeJson(response, 200, {
          urls: Object.fromEntries(parsed.keys.map((key) => [key, objectUrl(key)])),
          multipart: {},
        });
        return;
      }
      case "/capture.register": {
        const parsed = registerRequestSchema.parse(await readJsonBody(request));
        state.head = {
          n: parsed.n,
          capture_id: parsed.capture_id,
          manifest_key: parsed.manifest_key,
          manifest: parsed.manifest,
        };
        writeJson(response, 200, {
          head_n: parsed.n,
          head_capture_id: parsed.capture_id,
        });
        return;
      }
      case "/lease.heartbeat": {
        await readJsonBody(request);
        writeJson(response, 200, { expires_in_secs: 300 });
        return;
      }
      case "/change.summary": {
        await readJsonBody(request);
        writeJson(response, 200, {});
        return;
      }
      default: {
        response.writeHead(404);
        response.end();
      }
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      state.errors.push(error);
      if (!response.headersSent) {
        writeJson(response, 500, { reason: "capture-channel-test-error" });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Capture channel did not bind a TCP port.");
  }
  endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
};
