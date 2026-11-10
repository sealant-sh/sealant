/**
 * Mend's capture session channel for one worktree, run in a container on the twins' network.
 * The guest dials it from inside its isolated workspace namespace, which on a firewalled host
 * cannot reach a listener on the host itself. It is Core's `capture-channel.fixture.ts` behind a
 * thin proxy on port 9100 (the endpoint the guest is given), plus harness controls on port 9000:
 *
 * - `GET /harness/state`: the channel's view, for scenario assertions;
 * - `POST /harness/uploads` `{"fail": true|false}`: answer `upload.urls` and `capture.register`
 *   with 503, so the daemon keeps its work unsent (a session Mend cannot take yet);
 * - `POST /harness/epoch` `{"epoch": n}`: the capture epoch `plan.get` answers, as Mend's lease
 *   service advances it when another executor may take the session over.
 *
 * Env: CAPTURE_TOKEN, CAPTURE_WORKTREE_ID, CAPTURE_ADVERTISE_HOST.
 */
import http from "node:http";

import { z } from "zod";

import { startCaptureChannel } from "../src/runtime/capture-channel.fixture.js";

const PROXY_PORT = 9100;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const advertiseHost = required("CAPTURE_ADVERTISE_HOST");
const channel = await startCaptureChannel({
  token: required("CAPTURE_TOKEN"),
  worktreeId: required("CAPTURE_WORKTREE_ID"),
  advertiseHost,
});
const upstream = new URL(channel.endpoint);
const endpoint = `http://${advertiseHost}:${PROXY_PORT}`;
let failUploads = false;
let refusedUploads = 0;

const readBody = async (request: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// Object URLs name the fixture's own port; they bypass the proxy, which only gates the calls
// that hand them out.
http
  .createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://capture.invalid").pathname;
    if (failUploads && (path === "/upload.urls" || path === "/capture.register")) {
      refusedUploads += 1;
      request.resume();
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ reason: "harness-uploads-unavailable" }));
      return;
    }
    const forwarded = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    forwarded.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(forwarded);
  })
  .listen(PROXY_PORT, "0.0.0.0");

const json = (response: http.ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

http
  .createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://capture.invalid").pathname;
      if (request.method === "POST" && path === "/harness/uploads") {
        failUploads = z
          .object({ fail: z.boolean() })
          .parse(JSON.parse(String(await readBody(request)))).fail;
      } else if (request.method === "POST" && path === "/harness/epoch") {
        channel.state.epoch = z
          .object({ epoch: z.number().int().positive() })
          .parse(JSON.parse(String(await readBody(request)))).epoch;
      } else if (path !== "/harness/state") {
        json(response, 404, { reason: "not-found" });
        return;
      }
      json(response, 200, {
        endpoint,
        head: channel.state.head ?? null,
        planRequests: channel.state.planRequests,
        epoch: channel.state.epoch,
        executor: channel.state.executor ?? null,
        objects: channel.state.objects.size,
        errors: channel.state.errors.map(String),
        failUploads,
        refusedUploads,
      });
    })().catch((error: unknown) => json(response, 400, { reason: String(error) }));
  })
  .listen(9000, "0.0.0.0", () => {
    process.stdout.write(`capture channel ${endpoint}\n`);
  });
