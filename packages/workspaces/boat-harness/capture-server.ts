/**
 * Mend's capture session channel for one worktree, run in a container on the twins' network.
 * The guest dials it from inside its isolated workspace namespace, which on a firewalled host
 * cannot reach a listener on the host itself. It is sealant's `capture-channel.fixture.ts` behind a
 * thin proxy on port 9100 (the endpoint the guest is given), plus a read-only `/harness/state`
 * view on port 9000 for scenario assertions, and `POST /harness/register-fault` there to delay
 * every `capture.register` or refuse it with the channel's byte-quota answer. The proxy only observes: it records when each
 * `capture.register` was answered and whether it carried a FINAL seal the channel recorded, so a
 * scenario can check the FINAL was captured before Boat was asked to delete the VM.
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

/** Every answered `capture.register`: when, which capture, and whether it sealed a FINAL. */
const registers: Array<{ at: number; n: number | null; final: boolean; sealRecorded: boolean }> =
  [];

const finalSeal = z.looseObject({
  manifest: z.looseObject({
    final_seal: z.looseObject({ complete: z.boolean() }).optional(),
  }),
  n: z.number().optional(),
});
const sealAnswer = z.looseObject({ seal: z.looseObject({ state: z.string() }).optional() });

/**
 * The fault every `capture.register` meets until changed: `delayMs` holds it before it is
 * forwarded; `refuse` answers it 409 `byte-quota` (sealantd's terminal refusal for that capture)
 * without forwarding it.
 */
const registerFault = z.object({
  delayMs: z.number().int().nonnegative().optional(),
  refuse: z.boolean().optional(),
});
let fault: z.infer<typeof registerFault> = {};
/** Every register refused under the fault, as `at`. */
const refused: number[] = [];

const parseJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

// Object URLs name the fixture's own port; they bypass the proxy. Everything else passes through
// unchanged; a register's request and answer are buffered (small JSON) so they can be recorded.
http
  .createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://capture.invalid").pathname;
    const watched = path === "/capture.register";
    if (watched && fault.refuse === true) {
      refused.push(Date.now());
      request.resume();
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ reason: "byte-quota", limit: 1, used: 1, requested: 1 }));
      return;
    }
    const sent: Buffer[] = [];
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
        if (!watched) {
          answer.pipe(response);
          return;
        }
        const received: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => {
          received.push(chunk);
          response.write(chunk);
        });
        answer.on("end", () => {
          response.end();
          if (answer.statusCode !== 200) return;
          const asked = finalSeal.safeParse(parseJson(Buffer.concat(sent)));
          const told = sealAnswer.safeParse(parseJson(Buffer.concat(received)));
          registers.push({
            at: Date.now(),
            n: asked.success ? (asked.data.n ?? null) : null,
            final: asked.success && asked.data.manifest.final_seal?.complete === true,
            sealRecorded: told.success && told.data.seal?.state === "recorded",
          });
        });
      },
    );
    forwarded.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    if (watched) request.on("data", (chunk: Buffer) => sent.push(chunk));
    const delayMs = watched ? (fault.delayMs ?? 0) : 0;
    if (delayMs === 0) request.pipe(forwarded);
    else {
      // Buffered while it waits, then sent as it came.
      request.pause();
      setTimeout(() => {
        request.pipe(forwarded);
        request.resume();
      }, delayMs);
    }
  })
  .listen(PROXY_PORT, "0.0.0.0");

http
  .createServer((request, response) => {
    if (request.method === "POST" && request.url === "/harness/register-fault") {
      const body: Buffer[] = [];
      request.on("data", (chunk: Buffer) => body.push(chunk));
      request.on("end", () => {
        const parsed = registerFault.safeParse(parseJson(Buffer.concat(body)));
        if (!parsed.success) {
          response.writeHead(400);
          response.end();
          return;
        }
        fault = parsed.data;
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        endpoint,
        head: channel.state.head ?? null,
        planRequests: channel.state.planRequests,
        executor: channel.state.executor ?? null,
        objects: channel.state.objects.size,
        errors: channel.state.errors.map(String),
        registers,
        refused,
      }),
    );
  })
  .listen(9000, "0.0.0.0", () => {
    process.stdout.write(`capture channel ${endpoint}\n`);
  });
