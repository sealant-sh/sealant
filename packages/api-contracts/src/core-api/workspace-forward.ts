/**
 * The workspace forward's v2 wire contract: `GET /v1/workspaces/:workspaceId/forward/v2` with the
 * subprotocol {@link FORWARD_V2_SUBPROTOCOL}. A WHATWG `WebSocket` cannot read the status of a
 * refused upgrade, so v2 accepts the upgrade first and answers with one text frame: `ready`, after
 * which binary frames carry payload both ways, or `refused`, after which the server closes with
 * {@link FORWARD_REFUSED_CLOSE_CODE}. A request without an upgrade gets 426 and is never dialled.
 *
 * After `ready`, each direction is bounded by {@link FORWARD_V2_WINDOW}. A receiver sends
 * `progress` with the cumulative bytes and frames it has consumed; a sender keeps what it has sent
 * within the last `progress` plus the window, and sends nothing before the first `progress`
 * (`{0,0}`), which opens the receiver's window. A receiver resets a sender that goes past it.
 * `fin` ends one direction with the totals sent; `reset` ends both at once. Core sends a `progress`
 * naming exactly what reached the workspace before its `fin`, so a client can tell whether
 * everything it wrote arrived. {@link ForwardFlow} keeps this ledger for either side.
 */
import { Option, Schema } from "effect";

export const FORWARD_V2_SUBPROTOCOL = "sealant.forward.v2";

/** The largest binary frame either side may send. */
export const FORWARD_V2_MAX_FRAME_BYTES = 64 * 1024;

/** Ends the socket after a `refused` frame. It says nothing about why: the frame's reason does. */
export const FORWARD_REFUSED_CLOSE_CODE = 4400;

export const forwardRefusalReasonSchema = Schema.Literals([
  "workspace-not-ready",
  "runtime-unreachable",
  "runtime-untargetable",
  "connection-refused",
  "name-unresolved",
  "network-unreachable",
  "dial-timeout",
  "dial-failed",
  "not-found",
  "unauthorized",
  "forbidden",
  "budget-exceeded",
  "invalid-target",
  "owner-required",
  "internal",
  "owner-exited",
  "peer-mismatch",
  "binding-unverifiable",
  "binding-unsupported",
]);
export type ForwardRefusalReason = typeof forwardRefusalReasonSchema.Type;

/** The HTTP status each refusal would have had before the upgrade. Callers branch on the reason. */
export const FORWARD_REFUSAL_STATUS = {
  "workspace-not-ready": 409,
  "runtime-unreachable": 503,
  "runtime-untargetable": 503,
  "connection-refused": 502,
  "name-unresolved": 502,
  "network-unreachable": 502,
  "dial-timeout": 504,
  "dial-failed": 502,
  "not-found": 404,
  unauthorized: 401,
  forbidden: 403,
  "budget-exceeded": 429,
  "invalid-target": 400,
  "owner-required": 400,
  internal: 500,
  "owner-exited": 409,
  "peer-mismatch": 409,
  "binding-unverifiable": 409,
  "binding-unsupported": 409,
} as const satisfies Record<ForwardRefusalReason, number>;

/**
 * What a forward reaches: whatever holds the port (`port`), or only a process of the session that
 * `session` names (`session`), as the workspace runtime verified when it connected.
 */
export const forwardBindingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("port") }),
  Schema.Struct({ kind: Schema.Literal("session"), session: Schema.String }),
]);
export type ForwardBinding = typeof forwardBindingSchema.Type;

export const forwardReadyFrameSchema = Schema.Struct({
  t: Schema.Literal("ready"),
  version: Schema.Literal(2),
  binding: forwardBindingSchema,
});
export type ForwardReadyFrame = typeof forwardReadyFrameSchema.Type;

/**
 * Decoded with any `reason`, so a client keeps a refusal from a Core newer than itself, with the
 * status and message that Core sent.
 */
export const forwardRefusedFrameSchema = Schema.Struct({
  t: Schema.Literal("refused"),
  reason: Schema.String,
  message: Schema.String,
  status: Schema.Int,
});
export type ForwardRefusedFrame = typeof forwardRefusedFrameSchema.Type;

export const forwardRefusedFrame = (
  reason: ForwardRefusalReason,
  message: string,
): ForwardRefusedFrame => ({
  t: "refused",
  reason,
  message,
  status: FORWARD_REFUSAL_STATUS[reason],
});

/** The first frame the server sends on a v2 forward, as JSON text. */
export const forwardOpenFrameSchema = Schema.Union([
  forwardReadyFrameSchema,
  forwardRefusedFrameSchema,
]);
export type ForwardOpenFrame = typeof forwardOpenFrameSchema.Type;

/** What each direction of a v2 forward may have in flight beyond what its receiver consumed. */
export const FORWARD_V2_WINDOW = { bytes: 256 * 1024, frames: 32 } as const;

const counterSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,14})$/));

export const forwardProgressFrameSchema = Schema.Struct({
  t: Schema.Literal("progress"),
  bytes: counterSchema,
  frames: counterSchema,
});
export type ForwardProgressFrame = typeof forwardProgressFrameSchema.Type;

export const forwardFinFrameSchema = Schema.Struct({
  t: Schema.Literal("fin"),
  bytes: counterSchema,
  frames: counterSchema,
});
export type ForwardFinFrame = typeof forwardFinFrameSchema.Type;

export const forwardResetReasonSchema = Schema.Literals([
  "window-exceeded",
  "protocol-violation",
  "aborted",
  "target-error",
  "runtime-lost",
  "owner-exited",
]);
export type ForwardResetReason = typeof forwardResetReasonSchema.Type;

/** Decoded with any `reason`, so a client keeps a reset from a Core newer than itself. */
export const forwardResetFrameSchema = Schema.Struct({
  t: Schema.Literal("reset"),
  reason: Schema.String,
});
export type ForwardResetFrame = typeof forwardResetFrameSchema.Type;

/** The text frames either side sends after `ready`. */
export const forwardFlowFrameSchema = Schema.Union([
  forwardProgressFrameSchema,
  forwardFinFrameSchema,
  forwardResetFrameSchema,
]);
export type ForwardFlowFrame = typeof forwardFlowFrameSchema.Type;

interface ForwardCount {
  readonly bytes: number;
  readonly frames: number;
}

const NOTHING: ForwardCount = { bytes: 0, frames: 0 };

const plusFrame = (count: ForwardCount, bytes: number): ForwardCount => ({
  bytes: count.bytes + bytes,
  frames: count.frames + 1,
});

const countOf = (frame: ForwardProgressFrame | ForwardFinFrame): ForwardCount => ({
  bytes: Number(frame.bytes),
  frames: Number(frame.frames),
});

const sameCount = (a: ForwardCount, b: ForwardCount) =>
  a.bytes === b.bytes && a.frames === b.frames;

const withinWindow = (count: ForwardCount, granted: ForwardCount) =>
  count.bytes <= granted.bytes + FORWARD_V2_WINDOW.bytes &&
  count.frames <= granted.frames + FORWARD_V2_WINDOW.frames;

const counted = <T extends "progress" | "fin">(t: T, count: ForwardCount) => ({
  t,
  bytes: String(count.bytes),
  frames: String(count.frames),
});

const decodeFlowFrame = Schema.decodeUnknownOption(Schema.fromJsonString(forwardFlowFrameSchema));

/** What one frame from the peer meant, once the forward is open. */
export type ForwardInbound =
  | { readonly kind: "data"; readonly data: Uint8Array }
  | { readonly kind: "progress" }
  | { readonly kind: "fin" }
  | { readonly kind: "reset"; readonly reason: string }
  | { readonly kind: "violation"; readonly reason: "window-exceeded" | "protocol-violation" };

const violation = (reason: "window-exceeded" | "protocol-violation"): ForwardInbound => ({
  kind: "violation",
  reason,
});

/** A chunk as the binary frames it is sent in. */
export function* forwardFrames(chunk: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < chunk.byteLength; offset += FORWARD_V2_MAX_FRAME_BYTES) {
    yield chunk.subarray(offset, offset + FORWARD_V2_MAX_FRAME_BYTES);
  }
}

/**
 * Both directions of an open v2 forward as one side sees them, with no I/O: what it sent against
 * what its peer consumed, and what it received and consumed against what it granted. Core and the
 * SDK each drive one from their socket.
 *
 * A grant is made when its `progress` is sent, so a side that holds a `progress` back while its
 * socket is backed up also holds back its peer, and the next `progress` it sends names the latest
 * count: acknowledgements never queue.
 */
export class ForwardFlow {
  #sent = NOTHING;
  #peerConsumed: ForwardCount | undefined;
  #received = NOTHING;
  #consumed = NOTHING;
  #granted: ForwardCount | undefined;
  #finReceived = false;

  /** The first `progress`, which lets the peer start sending. */
  open(): ForwardProgressFrame {
    this.#granted = this.#consumed;
    return counted("progress", this.#consumed);
  }

  receive(frame: string | Uint8Array): ForwardInbound {
    if (typeof frame !== "string") {
      if (this.#finReceived) return violation("protocol-violation");
      this.#received = plusFrame(this.#received, frame.byteLength);
      const granted = this.#granted;
      return granted !== undefined && withinWindow(this.#received, granted)
        ? { kind: "data", data: frame }
        : violation("window-exceeded");
    }
    const decoded = decodeFlowFrame(frame);
    if (Option.isNone(decoded)) return violation("protocol-violation");
    switch (decoded.value.t) {
      case "progress":
        return this.#acceptPeerProgress(countOf(decoded.value))
          ? { kind: "progress" }
          : violation("protocol-violation");
      case "fin":
        if (this.#finReceived || !sameCount(countOf(decoded.value), this.#received)) {
          return violation("protocol-violation");
        }
        this.#finReceived = true;
        return { kind: "fin" };
      case "reset":
        return { kind: "reset", reason: decoded.value.reason };
    }
  }

  #acceptPeerProgress(consumed: ForwardCount): boolean {
    const previous = this.#peerConsumed ?? NOTHING;
    if (
      consumed.bytes > this.#sent.bytes ||
      consumed.frames > this.#sent.frames ||
      consumed.bytes < previous.bytes ||
      consumed.frames < previous.frames
    ) {
      return false;
    }
    this.#peerConsumed = consumed;
    return true;
  }

  /** Whether one frame of `bytes` fits in what the peer has granted. */
  canSend(bytes: number): boolean {
    const consumed = this.#peerConsumed;
    return consumed !== undefined && withinWindow(plusFrame(this.#sent, bytes), consumed);
  }

  sent(bytes: number): void {
    this.#sent = plusFrame(this.#sent, bytes);
  }

  /** Whether the peer has said it consumed everything this side sent. */
  get delivered(): boolean {
    return this.#peerConsumed !== undefined && sameCount(this.#peerConsumed, this.#sent);
  }

  fin(): ForwardFinFrame {
    return counted("fin", this.#sent);
  }

  consumed(bytes: number): void {
    this.#consumed = plusFrame(this.#consumed, bytes);
  }

  /** Whether what was consumed since the last `progress` reaches half the window. */
  get progressDue(): boolean {
    const granted = this.#granted ?? NOTHING;
    return (
      this.#consumed.bytes - granted.bytes >= FORWARD_V2_WINDOW.bytes / 2 ||
      this.#consumed.frames - granted.frames >= FORWARD_V2_WINDOW.frames / 2
    );
  }

  /** The `progress` to send now, when one is due. Taking it makes the grant. */
  takeProgress(): ForwardProgressFrame | undefined {
    if (!this.progressDue) return undefined;
    return this.open();
  }

  /** A `progress` naming exactly what was consumed, unless the last one already did. */
  takeFinalProgress(): ForwardProgressFrame | undefined {
    if (this.#granted !== undefined && sameCount(this.#granted, this.#consumed)) return undefined;
    return this.open();
  }
}
