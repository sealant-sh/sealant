/**
 * The workspace forward's v2 wire contract: `GET /v1/workspaces/:workspaceId/forward/v2` with the
 * subprotocol {@link FORWARD_V2_SUBPROTOCOL}. A WHATWG `WebSocket` cannot read the status of a
 * refused upgrade, so v2 accepts the upgrade first and answers with one text frame: `ready`, after
 * which binary frames carry payload both ways, or `refused`, after which the server closes with
 * {@link FORWARD_REFUSED_CLOSE_CODE}. A request without an upgrade gets 426 and is never dialled.
 */
import { Schema } from "effect";

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

export const forwardBindingSchema = Schema.Struct({ kind: Schema.Literal("port") });
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
