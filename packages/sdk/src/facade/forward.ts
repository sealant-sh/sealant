import {
  FORWARD_V2_MAX_FRAME_BYTES,
  FORWARD_V2_SUBPROTOCOL,
  type ForwardBinding,
  forwardOpenFrameSchema,
  forwardRefusalReasonSchema,
  type ForwardRefusedFrame,
} from "@sealant/api-contracts";
import { Option, Schema } from "effect";

import { ForwardDialError } from "../errors.js";
import type { WorkspaceForward, WorkspaceForwardOptions } from "../types.js";

export interface ForwardEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly ownerUserId: string;
}

const forwardUrl = (
  endpoint: ForwardEndpoint,
  path: string,
  query: Readonly<Record<string, string | undefined>>,
): URL => {
  const url = new URL(path, endpoint.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  // The owner assertion always rides the URL (a service principal needs it alongside its
  // key, and WebSocket cannot carry headers — same contract as the session attach).
  url.searchParams.set("ownerUserId", endpoint.ownerUserId);
  if (endpoint.apiKey !== undefined) {
    url.searchParams.set("token", endpoint.apiKey);
  }
  return url;
};

const bridgeForward = (
  ws: WebSocket,
  maxFrameBytes = Number.POSITIVE_INFINITY,
): { readonly forward: WorkspaceForward; readonly receive: (event: MessageEvent) => void } => {
  const pending: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const closedResolver = Promise.withResolvers<"end" | "closed">();
  const finish = (reason: "end" | "closed") => {
    if (finished) {
      return;
    }
    finished = true;
    closedResolver.resolve(reason);
    wake?.();
  };
  ws.addEventListener("close", () => finish("closed"));

  const receive = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      try {
        const frame = JSON.parse(event.data) as { t?: string };
        if (frame.t === "end") {
          finish("end");
        }
      } catch {}
      return;
    }
    pending.push(new Uint8Array(event.data as ArrayBuffer));
    wake?.();
  };

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

  const forward: WorkspaceForward = {
    send: (input) => {
      let offset = 0;
      do {
        // Copy into a plain ArrayBuffer-backed view (WebSocket.send rejects SharedArrayBuffer views).
        ws.send(new Uint8Array(input.subarray(offset, offset + maxFrameBytes)).buffer);
        offset += maxFrameBytes;
      } while (offset < input.byteLength);
    },
    eof: () => {
      ws.send(JSON.stringify({ t: "eof" }));
    },
    output,
    closed: closedResolver.promise,
    close: () => {
      finish("closed");
      ws.close();
    },
  };
  return { forward, receive };
};

export const openForward = (
  endpoint: ForwardEndpoint,
  workspaceId: string,
  port: number,
  options?: WorkspaceForwardOptions,
): Promise<WorkspaceForward> => {
  const url = forwardUrl(endpoint, `/v1/workspaces/${workspaceId}/forward`, {
    port: String(port),
    host: options?.host,
    protocol: options?.protocol === "udp" ? "udp" : undefined,
  });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const { forward, receive } = bridgeForward(ws);
    ws.addEventListener("message", receive);
    ws.addEventListener("open", () => resolve(forward), { once: true });
    ws.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            `workspace forward failed: could not connect to ${url.host} (is anything listening on 127.0.0.1:${port} in the workspace?)`,
          ),
        ),
      { once: true },
    );
  });
};

export interface ForwardV2Options {
  readonly host?: "127.0.0.1" | "localhost" | "docker";
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

const FORWARD_V2_OPEN_DEADLINE_MS = 30_000;

export interface OpenedForwardV2 {
  readonly binding: ForwardBinding;
  readonly forward: WorkspaceForward;
}

const decodeOpenFrame = Schema.decodeUnknownOption(Schema.fromJsonString(forwardOpenFrameSchema));
const isKnownRefusal = Schema.is(forwardRefusalReasonSchema);

const refusalError = (frame: ForwardRefusedFrame): ForwardDialError =>
  new ForwardDialError(
    isKnownRefusal(frame.reason)
      ? { reason: frame.reason, status: frame.status, message: frame.message }
      : {
          reason: "unrecognized-refusal",
          wireReason: frame.reason,
          status: frame.status,
          message: frame.message,
        },
  );

/** A gated Core before v2 answers the route 401, an open one 404. Core with v2 answers 426. */
const answeredLikeCoreBeforeV2 = (status: number): boolean => status === 401 || status === 404;

const failedHandshakeError = async (
  url: URL,
  origin: string,
  signal: AbortSignal,
): Promise<ForwardDialError> => {
  const probe = new URL(url.pathname, url);
  probe.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const unavailable = (detail: string) =>
    new ForwardDialError({
      reason: "transport-unavailable",
      message: `The forward could not open a WebSocket to ${origin}; ${detail}.`,
    });
  try {
    const response = await fetch(probe, { signal });
    await response.body?.cancel();
    if (answeredLikeCoreBeforeV2(response.status)) {
      return new ForwardDialError({
        reason: "protocol-unsupported",
        message: `${origin} does not serve /forward/v2; it predates typed forward refusals.`,
      });
    }
    return unavailable(`a plain request to the route got ${response.status}`);
  } catch {
    return unavailable("a plain request to the route got no answer");
  }
};

export const openForwardV2 = (
  endpoint: ForwardEndpoint,
  workspaceId: string,
  port: number,
  options?: ForwardV2Options,
): Promise<OpenedForwardV2> => {
  const host = options?.host ?? "127.0.0.1";
  const signal = options?.signal;
  const deadlineMs = options?.deadlineMs ?? FORWARD_V2_OPEN_DEADLINE_MS;
  const url = forwardUrl(endpoint, `/v1/workspaces/${workspaceId}/forward/v2`, {
    port: String(port),
    host,
  });
  const origin = new URL(endpoint.baseUrl).origin;

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason);
    const ws = new WebSocket(url, FORWARD_V2_SUBPROTOCOL);
    ws.binaryType = "arraybuffer";
    const { forward, receive } = bridgeForward(ws, FORWARD_V2_MAX_FRAME_BYTES);
    const probing = new AbortController();
    let phase: "handshake" | "awaiting-answer" | "probing" | "open" | "failed" = "handshake";

    const settle = (next: "open" | "failed") => {
      phase = next;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      probing.abort();
    };
    const fail = (error: unknown) => {
      if (phase === "open" || phase === "failed") return;
      settle("failed");
      ws.close();
      reject(error);
    };
    const unreadable = (message: string) =>
      fail(new ForwardDialError({ reason: "protocol-unsupported", message }));
    const onAbort = () => fail(signal?.reason);
    const deadline = setTimeout(
      () =>
        fail(
          new ForwardDialError({
            reason: "transport-unavailable",
            message: `${origin} did not open the forward within ${deadlineMs} ms.`,
          }),
        ),
      deadlineMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      phase = "awaiting-answer";
      if (ws.protocol !== FORWARD_V2_SUBPROTOCOL) {
        unreadable(
          `${origin} accepted the forward without the ${FORWARD_V2_SUBPROTOCOL} protocol.`,
        );
      }
    });
    ws.addEventListener("message", (event) => {
      if (phase === "open") return receive(event);
      if (phase !== "awaiting-answer") return;
      const frame = typeof event.data === "string" ? decodeOpenFrame(event.data) : Option.none();
      if (Option.isNone(frame)) {
        return unreadable(`${origin} answered the forward with a frame this SDK cannot read.`);
      }
      if (frame.value.t === "refused") return fail(refusalError(frame.value));
      settle("open");
      resolve({ binding: frame.value.binding, forward });
    });
    ws.addEventListener("close", () => {
      if (phase === "awaiting-answer") {
        return fail(
          new ForwardDialError({
            reason: "transport-unavailable",
            message: `The forward's connection to ${origin} closed before the control plane answered.`,
          }),
        );
      }
      if (phase !== "handshake") return;
      phase = "probing";
      void failedHandshakeError(url, origin, probing.signal).then(fail);
    });
  });
};
