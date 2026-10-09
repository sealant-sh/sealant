/**
 * `SessionRequestRefusal` (see its contract): a session create the contract cannot decode answers
 * `400` `SessionBadRequestError` with a value-free reason, and the failure the request logger sees
 * is that error, never Effect's decode cause. That cause quotes the rejected input (`Expected array,
 * got "<argv>"`, a whole body wrapped in an array, `JSON.parse`'s excerpt of a malformed body), and a
 * session's arguments can hold secrets.
 */
import {
  createSessionAsUserRequestSchema,
  SessionBadRequestError,
  sessionCreateRequestIssue,
  SessionRequestRefusal,
} from "@sealant/api-contracts";
import { Cause, Effect, Layer, SchemaIssue } from "effect";
import type { unhandled } from "effect/Types";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiError } from "effect/unstable/httpapi";

const { HttpApiSchemaError } = HttpApiError;

const REQUEST_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(createSessionAsUserRequestSchema.fields),
);

/** The request field an issue is about: a field of the contract, never a key the caller chose. */
const fieldOf = (issue: SchemaIssue.Issue): string | undefined => {
  if (issue instanceof SchemaIssue.Pointer) {
    const key = issue.path[0];
    return typeof key === "string" && REQUEST_FIELDS.has(key) ? key : fieldOf(issue.issue);
  }
  if (issue instanceof SchemaIssue.Filter || issue instanceof SchemaIssue.Encoding) {
    return fieldOf(issue.issue);
  }
  if (issue instanceof SchemaIssue.Composite || issue instanceof SchemaIssue.AnyOf) {
    for (const inner of issue.issues) {
      const field = fieldOf(inner);
      if (field !== undefined) return field;
    }
  }
  return undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The reason for an undecodable payload, from the body itself and, failing that, the issue. */
const payloadRefusal = (error: HttpApiError.HttpApiSchemaError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => undefined));
    const body = text === undefined || text === "" ? undefined : parseJson(text);
    const reason = body === undefined ? undefined : sessionCreateRequestIssue(body);
    if (reason !== undefined) return reason;
    const field = fieldOf(error.cause.issue);
    return field === undefined
      ? "the request body is not a session request"
      : `${field} is missing or invalid`;
  });

/** A value-free reason for a decode failure in `cause`, or `undefined` for any other failure. */
const refusalOf = (cause: Cause.Cause<unknown>) => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && HttpApiSchemaError.is(reason.error)) {
      const error = reason.error;
      // `Body` is the response failing to encode: the server's fault, not the request's.
      if (error.kind === "Body") return undefined;
      return error.kind === "Payload"
        ? payloadRefusal(error)
        : Effect.succeed(`the request's ${error.kind.toLowerCase()} are invalid`);
    }
    // HttpApi parses a JSON body with `JSON.parse` outside its error channel: a malformed body is a
    // defect whose message quotes part of the body.
    if (Cause.isDieReason(reason) && reason.defect instanceof SyntaxError) {
      return Effect.succeed("the request body is not valid JSON");
    }
  }
  return undefined;
};

export const SessionRequestRefusalLive: Layer.Layer<SessionRequestRefusal> = Layer.succeed(
  SessionRequestRefusal,
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchCause(
        (
          cause,
        ): Effect.Effect<
          never,
          unhandled | SessionBadRequestError,
          HttpServerRequest.HttpServerRequest
        > => {
          const refusal = refusalOf(cause);
          if (refusal === undefined) return Effect.failCause(cause);
          return Effect.flatMap(refusal, (message) =>
            Effect.fail(new SessionBadRequestError({ message })),
          );
        },
      ),
    ),
);
