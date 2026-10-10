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
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiError, type HttpApiEndpoint } from "effect/unstable/httpapi";

const { HttpApiSchemaError } = HttpApiError;

const PART: Record<HttpApiError.HttpApiSchemaError["kind"], string> = {
  Payload: "body",
  Params: "path parameters",
  Query: "query",
  Headers: "headers",
  Body: "response",
};

const isJsonText = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether a `SyntaxError` defect is HttpApi's parse of this request's body (it parses a JSON payload
 * with `JSON.parse` outside its error channel, so a malformed body is a defect quoting part of
 * it): only for an endpoint that takes a payload, and only when the body, read again from the
 * request's cache, is not JSON. A handler's or an encoder's `SyntaxError` on a valid request stays
 * the server's failure (500, reported). Read only on this failure path, so a request that decodes
 * pays nothing.
 */
const isBodyParseFailure = (endpoint: HttpApiEndpoint.AnyWithProps) =>
  Effect.gen(function* () {
    if (endpoint.payload.size === 0) return false;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => undefined));
    return text !== undefined && text !== "" && !isJsonText(text);
  });

/** A value-free reason for a decode failure in `cause`, or `undefined` for any other failure. */
const refusalOf = (cause: Cause.Cause<unknown>, endpoint: HttpApiEndpoint.AnyWithProps) =>
  Effect.gen(function* () {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason) && HttpApiSchemaError.is(reason.error)) {
        const { kind, cause: schemaError } = reason.error;
        // `Body` is the response failing to encode: the server's fault, not the request's.
        if (kind === "Body") return undefined;
        return describeRequestIssue(PART[kind], schemaError.issue);
      }
      if (
        Cause.isDieReason(reason) &&
        reason.defect instanceof SyntaxError &&
        (yield* isBodyParseFailure(endpoint))
      ) {
        return REQUEST_BODY_NOT_JSON;
      }
    }
    return undefined;
  });

export const RequestRefusalLive: Layer.Layer<RequestRefusal> = Layer.succeed(
  RequestRefusal,
  (httpEffect, { endpoint }) =>
    httpEffect.pipe(
      Effect.catchCause(
        (
          cause,
        ): Effect.Effect<
          never,
          unhandled | RequestRefusedError,
          HttpServerRequest.HttpServerRequest
        > =>
          Effect.flatMap(
            refusalOf(cause, endpoint),
            (message): Effect.Effect<never, unhandled | RequestRefusedError> =>
              message === undefined
                ? Effect.failCause(cause)
                : Effect.fail(new RequestRefusedError({ message })),
          ),
      ),
    ),
);
