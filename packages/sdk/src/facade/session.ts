/**
 * The `InteractiveSession` facade — a durable PTY session as the SDK exposes it.
 *
 * Sessions are platform resources: the PTY lives daemon-side and every verb here is a plain HTTP
 * call, so a handle can be dropped, the process restarted, and the session re-fetched by id from
 * any workspace handle. `output()` is the resumable read: it streams the session's RECORDED output
 * (byte-exact, redacted, sequence-keyed) over the SSE endpoint, falling back to polling the range
 * endpoint if the SSE transport is unavailable. The SSE `id` is the durable telemetry sequence, so
 * `from: lastChunk.sequence + 1n` resumes with no gap after any disconnect.
 */
import type { SessionWire } from "@sealant/api-contracts";

import {
  closeSessionOp,
  getSessionOp,
  getSessionOutputOp,
  resizeSessionOp,
  sendSessionInputOp,
  signalSessionOp,
} from "../effect/operations.js";
import type {
  InteractiveSession,
  InteractiveSessionStatus,
  SessionAttachment,
  SessionAttachOptions,
  SessionOutputChunk,
} from "../types.js";
import type { SdkContext } from "./context.js";

/**
 * Open the held-WebSocket terminal attachment (the data plane). One socket:
 * binary frames are PTY bytes in both directions, text frames are control
 * JSON (`{"t":"resize",...}` up, `{"t":"end"}` down). Auth rides the connect —
 * `?ownerUserId=` always, plus `?token=` for apiKey clients (WebSocket cannot
 * set headers; a service principal needs the owner assertion *and* its key) —
 * and never repeats per event.
 */
const openAttachment = (
  ctx: SdkContext,
  sessionId: string,
  options: SessionAttachOptions | undefined,
): Promise<SessionAttachment> => {
  const config = ctx.config;
  const url = new URL(`/v1/sessions/${sessionId}/attach`, config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("from", (options?.from ?? 0n).toString());
  // The owner assertion always rides the URL; a service principal needs it *alongside* its key,
  // and WebSocket cannot carry headers, so the key rides the URL too.
  url.searchParams.set("ownerUserId", config.hostLocal.ownerUserId);
  if (config.apiKey !== undefined) {
    url.searchParams.set("token", config.apiKey);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    // Push-queue bridging WS message events to the pull-based async iterable.
    const pending: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const closedResolver = Promise.withResolvers<"end" | "closed">();
    const closed = closedResolver.promise;
    const finish = (reason: "end" | "closed") => {
      if (finished) {
        return;
      }
      finished = true;
      closedResolver.resolve(reason);
      wake?.();
    };

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data) as { t?: string };
          if (frame.t === "end") {
            finish("end");
          }
        } catch {
          // Unknown text frame — ignore.
        }
        return;
      }
      pending.push(new Uint8Array(event.data as ArrayBuffer));
      wake?.();
    });
    ws.addEventListener("close", () => finish("closed"));

    const output: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            const chunk = pending.shift();
            if (chunk !== undefined) {
              return { done: false, value: chunk };
            }
            if (finished) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
        },
      }),
    };

    const attachment: SessionAttachment = {
      send: (input) => {
        const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
        // Copy into a plain ArrayBuffer-backed view (WebSocket.send rejects SharedArrayBuffer views).
        ws.send(new Uint8Array(bytes).buffer);
      },
      resize: (cols, rows) => {
        ws.send(JSON.stringify({ t: "resize", cols, rows }));
      },
      output,
      closed,
      close: () => {
        finish("closed");
        ws.close();
      },
    };

    ws.addEventListener("open", () => resolve(attachment), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error(`session attach failed: could not connect to ${url.host}`)),
      { once: true },
    );
  });
};

const OUTPUT_POLL_INTERVAL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const decodeBase64 = (value: string): Uint8Array => {
  const buffer = Buffer.from(value, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};

/** Parse one SSE frame block ("event: ...\nid: ...\ndata: ...") into its fields. */
const parseSseFrame = (
  block: string,
): { event: string; id: string | undefined; data: string } | undefined => {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue; // comment / keep-alive
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && id === undefined) {
    return undefined;
  }
  return { event, id, data: dataLines.join("\n") };
};

/** Stream the session's output over SSE. Throws on transport failure (caller falls back). */
async function* streamOverSse(
  ctx: SdkContext,
  sessionId: string,
  from: bigint,
  signal: AbortSignal | undefined,
): AsyncGenerator<SessionOutputChunk> {
  const config = ctx.config;
  const fetchImpl = config.fetch ?? fetch;
  const url = new URL(`/v1/sessions/${sessionId}/output/stream`, config.baseUrl);
  url.searchParams.set("from", from.toString());
  url.searchParams.set("ownerUserId", config.hostLocal.ownerUserId);

  const response = await fetchImpl(url, {
    headers: {
      accept: "text/event-stream",
      ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`session output stream failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const frame = parseSseFrame(block);
        if (frame === undefined) {
          continue;
        }
        if (frame.event === "end") {
          return;
        }
        if (frame.event === "output" && frame.id !== undefined) {
          yield { sequence: BigInt(frame.id), data: decodeBase64(frame.data) };
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Poll-backed fallback: page the range endpoint until the session settles. */
async function* streamByPolling(
  ctx: SdkContext,
  sessionId: string,
  from: bigint,
  signal: AbortSignal | undefined,
): AsyncGenerator<SessionOutputChunk> {
  let cursor = from;
  for (;;) {
    if (signal?.aborted === true) {
      return;
    }
    const page = await ctx.runtime.run(
      getSessionOutputOp(sessionId, {
        ownerUserId: ctx.config.hostLocal.ownerUserId,
        from: cursor.toString(),
      }),
    );
    for (const chunk of page.chunks) {
      yield { sequence: BigInt(chunk.sequence), data: decodeBase64(chunk.dataBase64) };
    }
    cursor = BigInt(page.nextFrom);
    if (page.chunks.length === 0) {
      if (page.status === "exited" || page.status === "failed") {
        return;
      }
      await delay(OUTPUT_POLL_INTERVAL_MS);
    }
  }
}

export const makeInteractiveSession = (ctx: SdkContext, wire: SessionWire): InteractiveSession => {
  const sessionId = wire.sessionId;

  return {
    id: sessionId,
    workspaceId: wire.workspaceId,
    runId: wire.runId,
    mode: wire.mode ?? "pty",

    send: async (input) => {
      const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
      await ctx.runtime.run(
        sendSessionInputOp(sessionId, {
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          dataBase64: Buffer.from(bytes).toString("base64"),
        }),
      );
    },

    output: (options) => {
      const from = options?.from ?? 0n;
      const signal = options?.signal;
      async function* iterate(): AsyncGenerator<SessionOutputChunk> {
        let cursor = from;
        try {
          for await (const chunk of streamOverSse(ctx, sessionId, cursor, signal)) {
            yield chunk;
            cursor = chunk.sequence + 1n;
          }
          return;
        } catch (error) {
          if (signal?.aborted === true) {
            return;
          }
          // SSE transport unavailable (proxy, fetch impl, older server) — fall back to polling
          // from the cursor; the sequence keying makes the switch seamless.
          void error;
        }
        yield* streamByPolling(ctx, sessionId, cursor, signal);
      }
      return iterate();
    },

    resize: async (cols, rows) => {
      await ctx.runtime.run(
        resizeSessionOp(sessionId, {
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          cols,
          rows,
        }),
      );
    },

    signal: async (signalNumber) => {
      await ctx.runtime.run(
        signalSessionOp(sessionId, {
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          signal: signalNumber,
        }),
      );
    },

    status: async (): Promise<InteractiveSessionStatus> => {
      const current = await ctx.runtime.run(
        getSessionOp(sessionId, ctx.config.hostLocal.ownerUserId),
      );
      return {
        status: current.status,
        ...(current.exitCode === undefined ? {} : { exitCode: current.exitCode }),
        ...(current.exitSignal === undefined ? {} : { exitSignal: current.exitSignal }),
        outputHighWater: BigInt(current.outputHighWater),
      };
    },

    close: async () => {
      await ctx.runtime.run(
        closeSessionOp(sessionId, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
      );
    },

    attach: (options) => openAttachment(ctx, sessionId, options),
  };
};
