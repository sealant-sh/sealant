/**
 * `RequestRefusal` (see its contract, `@sealant/api-contracts` `request-refusal.ts`), applied to every
 * control plane route: a request the contract cannot decode answers `400` `RequestRefusedError` with
 * a value-free reason, and Effect's decode failure, which quotes the rejected input, goes no further.
 * The request log, every `ErrorReporter` and the request's tracing span see only the refusal.
 */
import {
  describeRequestIssue,
  REQUEST_BODY_NOT_JSON,
  RequestRefusal,
  RequestRefusedError,
} from "@sealant/api-contracts";
import { Cause, Effect, Layer } from "effect";
import type { unhandled } from "effect/Types";
import { HttpApiError } from "effect/unstable/httpapi";

const { HttpApiSchemaError } = HttpApiError;

const PART: Record<HttpApiError.HttpApiSchemaError["kind"], string> = {
  Payload: "body",
  Params: "path parameters",
  Query: "query",
  Headers: "headers",
  Body: "response",
};

/** A value-free reason for a decode failure in `cause`, or `undefined` for any other failure. */
const refusalOf = (cause: Cause.Cause<unknown>): string | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && HttpApiSchemaError.is(reason.error)) {
      const { kind, cause: schemaError } = reason.error;
      // `Body` is the response failing to encode: the server's fault, not the request's.
      if (kind === "Body") return undefined;
      return describeRequestIssue(PART[kind], schemaError.issue);
    }
    // HttpApi parses a JSON body with `JSON.parse` outside its error channel: a malformed body is a
    // defect whose message quotes part of the body.
    if (Cause.isDieReason(reason) && reason.defect instanceof SyntaxError) {
      return REQUEST_BODY_NOT_JSON;
    }
  }
  return undefined;
};

export const RequestRefusalLive: Layer.Layer<RequestRefusal> = Layer.succeed(
  RequestRefusal,
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, unhandled | RequestRefusedError> => {
        const message = refusalOf(cause);
        return message === undefined
          ? Effect.failCause(cause)
          : Effect.fail(new RequestRefusedError({ message }));
      }),
    ),
);
