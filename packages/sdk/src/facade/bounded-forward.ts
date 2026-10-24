import {
  CountQueuingStrategy,
  ReadableStream,
  type ReadableStreamDefaultController,
  WritableStream,
  type WritableStreamDefaultController,
} from "node:stream/web";

import {
  FORWARD_V2_MAX_FRAME_BYTES,
  type ForwardBinding,
  ForwardFlow,
  forwardFrames,
  forwardResetReasonSchema,
  type ForwardResetReason,
} from "@sealant/api-contracts";
import { Schema } from "effect";

import { ForwardResetError } from "../errors.js";
import type {
  BoundedWorkspaceForward,
  BoundedWorkspaceForwardClose,
  ForwardResetCause,
} from "../types.js";

const isKnownReset = Schema.is(forwardResetReasonSchema);

const SOCKET_HIGH_WATER_BYTES = FORWARD_V2_MAX_FRAME_BYTES;
/** A WHATWG socket has no drain event, so a held `progress` checks again this often. */
const HELD_PROGRESS_RETRY_MS = 10;

type State =
  | { readonly kind: "open" }
  | { readonly kind: "ended" }
  | {
      readonly kind: "failed";
      readonly error: ForwardResetError;
      readonly readable: "errored" | "drains-what-arrived";
    };

export const boundedForward = (
  ws: WebSocket,
  binding: ForwardBinding,
  onWindowOpen: () => void,
): BoundedWorkspaceForward => {
  const flow = new ForwardFlow();
  const unread: Uint8Array[] = [];
  const closed = Promise.withResolvers<BoundedWorkspaceForwardClose>();
  let state: State = { kind: "open" };
  let windowOpen = false;
  let finReceived = false;
  let reader: ReadableStreamDefaultController<Uint8Array> | undefined;
  let writer: WritableStreamDefaultController | undefined;
  let pendingRead: (() => void) | undefined;
  let creditWaiter: (() => void) | undefined;
  let progressRetry: ReturnType<typeof setTimeout> | undefined;

  const sendText = (frame: object) => ws.send(JSON.stringify(frame));
  const wakeReader = () => {
    const waiter = pendingRead;
    pendingRead = undefined;
    waiter?.();
  };
  const wakeWriter = () => {
    const waiter = creditWaiter;
    creditWaiter = undefined;
    waiter?.();
  };

  const settle = (
    next: Exclude<State, { readonly kind: "open" }>,
    close: BoundedWorkspaceForwardClose,
  ) => {
    if (state.kind !== "open") return;
    state = next;
    clearTimeout(progressRetry);
    closed.resolve(close);
    if (next.kind === "failed") {
      writer?.error(next.error);
      if (next.readable === "errored") reader?.error(next.error);
    }
    wakeReader();
    wakeWriter();
  };
  const resetBy = (reason: ForwardResetCause, wireReason?: string) =>
    settle(
      { kind: "failed", error: new ForwardResetError(reason, wireReason), readable: "errored" },
      { kind: "reset", reason, ...(wireReason === undefined ? {} : { wireReason }) },
    );
  const reset = (reason: ForwardResetReason) => {
    if (state.kind !== "open") return;
    if (ws.readyState === WebSocket.OPEN) sendText({ t: "reset", reason });
    resetBy(reason);
    ws.close();
  };
  const endedByWorkspace = () => {
    if (flow.delivered && creditWaiter === undefined) {
      return settle({ kind: "ended" }, { kind: "end" });
    }
    settle(
      {
        kind: "failed",
        error: new ForwardResetError("workspace-ended"),
        readable: "drains-what-arrived",
      },
      { kind: "reset", reason: "workspace-ended" },
    );
  };

  const sendProgress = () => {
    if (state.kind !== "open" || ws.readyState !== WebSocket.OPEN || !flow.progressDue) return;
    if (ws.bufferedAmount > SOCKET_HIGH_WATER_BYTES) {
      progressRetry ??= setTimeout(() => {
        progressRetry = undefined;
        sendProgress();
      }, HELD_PROGRESS_RETRY_MS);
      return;
    }
    const progress = flow.takeProgress();
    if (progress !== undefined) sendText(progress);
  };
  const deliver = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    controller.enqueue(chunk);
    flow.consumed(chunk.byteLength);
    sendProgress();
  };

  const onInbound = (frame: string | Uint8Array) => {
    const inbound = flow.receive(frame);
    switch (inbound.kind) {
      case "data":
        if (pendingRead === undefined || reader === undefined) {
          unread.push(inbound.data);
          return;
        }
        deliver(reader, inbound.data);
        return wakeReader();
      case "progress":
        if (!windowOpen) {
          windowOpen = true;
          onWindowOpen();
        }
        return wakeWriter();
      case "fin":
        finReceived = true;
        if (unread.length === 0) reader?.close();
        wakeReader();
        return endedByWorkspace();
      case "reset": {
        const known = isKnownReset(inbound.reason);
        resetBy(known ? inbound.reason : "unrecognized-reset", known ? undefined : inbound.reason);
        return ws.close();
      }
      case "violation":
        return reset(inbound.reason);
    }
  };
  ws.addEventListener("message", (event) => {
    if (state.kind !== "open") return;
    if (event.data instanceof ArrayBuffer) onInbound(new Uint8Array(event.data));
    else if (typeof event.data === "string") onInbound(event.data);
  });
  ws.addEventListener("close", () => resetBy("connection-lost"));

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        reader = controller;
      },
      pull: (controller) => {
        const chunk = unread.shift();
        if (chunk === undefined) {
          return new Promise<void>((resolve) => {
            pendingRead = resolve;
          });
        }
        deliver(controller, chunk);
        if (finReceived && unread.length === 0) controller.close();
      },
      cancel: () => reset("aborted"),
    },
    { highWaterMark: 0 },
  );

  const waitForCredit = (fits: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (state.kind === "failed") return reject(state.error);
        if (state.kind === "ended") return reject(new ForwardResetError("workspace-ended"));
        if (fits()) return resolve();
        creditWaiter = check;
      };
      check();
    });

  const holdReadyUntilCredit = () => waitForCredit(() => flow.canSend(1));

  const writable = new WritableStream<Uint8Array>(
    {
      start: (controller) => {
        writer = controller;
        // The sink's own `abort` runs only after a write waiting for credit settles. Node has had
        // `signal` since 18; its types still lack it.
        const signal = "signal" in controller ? controller.signal : undefined;
        if (!(signal instanceof AbortSignal)) return;
        signal.addEventListener("abort", () => {
          // The stream is already erroring: erroring it again from here breaks Node's abort.
          writer = undefined;
          reset("aborted");
        });
      },
      write: async (chunk) => {
        for (const frame of forwardFrames(chunk)) {
          await waitForCredit(() => flow.canSend(frame.byteLength));
          flow.sent(frame.byteLength);
          // A copy: a WHATWG socket refuses a view of a SharedArrayBuffer.
          ws.send(new Uint8Array(frame));
        }
        await holdReadyUntilCredit();
      },
      close: () => {
        if (state.kind === "open") sendText(flow.fin());
      },
      abort: () => reset("aborted"),
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );

  sendText(flow.open());

  return {
    readable,
    writable,
    binding,
    closed: closed.promise,
    close: () => reset("aborted"),
  };
};
