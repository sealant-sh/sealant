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

/** The request's media type as HttpApi reads it to pick a payload decoder (JSON when absent). */
const mediaTypeOf = (request: HttpServerRequest.HttpServerRequest): string => {
  const contentType = (request.headers["content-type"] ?? "application/json").toLowerCase().trim();
  const semicolon = contentType.indexOf(";");
  return semicolon === -1 ? contentType : contentType.slice(0, semicolon).trim();
};

/** Whether HttpApi decodes this request's body as JSON for `endpoint` (not text, form or bytes). */
const decodesJson = (
  endpoint: HttpApiEndpoint.AnyWithProps,
  request: HttpServerRequest.HttpServerRequest,
): boolean => {
  const entry = endpoint.payload.get(mediaTypeOf(request));
  if (entry === undefined) return false;
  const { _tag: decoder } = entry.encoding;
  return decoder === "Json";
};

/**
 * Whether a `SyntaxError` defect is HttpApi's own parse of this request's body. HttpApi parses a
 * JSON payload with `JSON.parse` outside its error channel, before the handler runs, so a malformed
 * body is a defect quoting part of it. It is that parse only when the endpoint decodes this media
 * type as JSON and the body, read again from the request's cache, is not JSON: such a request never
 * reaches its handler. Anything else (a text payload such as GitHub's webhook, a handler's or an
 * encoder's own `SyntaxError`) stays the server's failure, a reported 500. Read only on this
 * failure path, so a request that decodes pays nothing.
 */
const isBodyParseFailure = (endpoint: HttpApiEndpoint.AnyWithProps) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!decodesJson(endpoint, request)) return false;
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
