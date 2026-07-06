/**
 * Inference on connected accounts — run short, tool-calling inference loops on the caller's OWN
 * subscription (their connected Claude account), server-side, WITHOUT the caller ever seeing
 * secret material.
 *
 * COMPLIANCE (docs/connected-accounts-design.md, load-bearing): stored subscription credentials are
 * NEVER used for raw model-API calls. The server resolves the account reference, decrypts, and
 * invokes the OFFICIAL Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` — the exact consumption path
 * Anthropic documents for third-party apps. Requests carry account REFERENCES only; responses carry
 * assistant turns only; token material never crosses this surface in either direction.
 *
 * The tool loop is CALLER-EXECUTED: the request may define JSON-schema tools; when the model calls
 * one, the server parks the run and responds with the pending `toolCalls` turn + a `sessionId`; the
 * caller executes the tools on ITS side and posts the results back with that `sessionId`, repeating
 * until a `text` turn arrives. Sessions are held in memory by the serving process and expire after
 * a few idle minutes — callers must handle `InferenceNotFoundError` on a continuation by starting
 * the exchange over.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

/**
 * Connected-account selection — the same reference shape as workspace creation: values are account
 * ids (`cacc_…`) or per-provider account names; explicit entries win over the profile's bindings.
 * `claude` is the only provider implemented today; a `codex` selection is accepted by the schema
 * (shape parity with workspaces) but rejected with a 400 until Codex inference ships.
 */
export const inferenceCredentialsSchema = Schema.Struct({
  profileId: Schema.optional(NonEmptyString),
  claude: Schema.optional(NonEmptyString),
  codex: Schema.optional(NonEmptyString),
});
export type InferenceCredentials = typeof inferenceCredentialsSchema.Type;

/** A caller-defined tool. `inputSchema` is a JSON Schema object, passed to the model verbatim. */
export const inferenceToolSchema = Schema.Struct({
  name: NonEmptyString,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Unknown,
});
export type InferenceTool = typeof inferenceToolSchema.Type;

/** The caller's result for one parked tool call, keyed by the server-minted `toolCallId`. */
export const inferenceToolResultSchema = Schema.Struct({
  toolCallId: NonEmptyString,
  content: Schema.String,
  isError: Schema.optional(Schema.Boolean),
});
export type InferenceToolResult = typeof inferenceToolResultSchema.Type;

/**
 * One respond call, in one of two shapes:
 *
 * - NEW exchange: `credentials` + `prompt` (plus optional `system`/`model`/`tools`/
 *   `responseFormat`/`maxTurns`). `sessionId`/`toolResults` must be absent.
 * - CONTINUATION: `sessionId` + `toolResults` for the previous turn's tool calls. The session was
 *   authenticated when it started; credential fields must be absent.
 */
export const inferenceRespondRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  credentials: Schema.optional(inferenceCredentialsSchema),
  prompt: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  system: Schema.optional(Schema.String),
  /** Model override passed to the agent SDK (defaults to the SDK's default model). */
  model: Schema.optional(NonEmptyString),
  /** Upper bound on agentic turns within one exchange (default 16). */
  maxTurns: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 64 })),
  ),
  tools: Schema.optional(Schema.Array(inferenceToolSchema).check(Schema.isMaxLength(32))),
  /**
   * Structured-output option: instructs the model to answer as JSON (conforming to `schema` when
   * given) and parses the final text; the parsed value arrives as the text turn's `json` field.
   * Best-effort — when the text does not parse, `json` is absent and `text` still carries the raw
   * answer.
   */
  responseFormat: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("json"),
      schema: Schema.optional(Schema.Unknown),
    }),
  ),
  sessionId: Schema.optional(NonEmptyString),
  toolResults: Schema.optional(Schema.Array(inferenceToolResultSchema).check(Schema.isNonEmpty())),
});
export type InferenceRespondRequest = typeof inferenceRespondRequestSchema.Type;

/** A tool call the model made; the caller executes it and posts the result back. */
export const inferenceToolCallSchema = Schema.Struct({
  toolCallId: NonEmptyString,
  name: NonEmptyString,
  input: Schema.Unknown,
});
export type InferenceToolCall = typeof inferenceToolCallSchema.Type;

/** The assistant turn: either the final text (with optional parsed `json`) or pending tool calls. */
export const inferenceTurnSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    json: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("toolCalls"),
    calls: Schema.Array(inferenceToolCallSchema),
  }),
]);
export type InferenceTurn = typeof inferenceTurnSchema.Type;

export const inferenceUsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
export type InferenceUsage = typeof inferenceUsageSchema.Type;

export const inferenceRespondResponseSchema = Schema.Struct({
  sessionId: NonEmptyString,
  turn: inferenceTurnSchema,
  /** Usage for the exchange so far; present on the final (text) turn. */
  usage: Schema.optional(inferenceUsageSchema),
});
export type InferenceRespondResponse = typeof inferenceRespondResponseSchema.Type;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class InferenceBadRequestError extends Schema.TaggedErrorClass<InferenceBadRequestError>()(
  "InferenceBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Unknown account/profile (uniform for foreign owners) or an expired/unknown inference session. */
export class InferenceNotFoundError extends Schema.TaggedErrorClass<InferenceNotFoundError>()(
  "InferenceNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The selected account exists but is not usable (status "invalid") — reconnect it. */
export class InferenceConflictError extends Schema.TaggedErrorClass<InferenceConflictError>()(
  "InferenceConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class InferenceUnavailableError extends Schema.TaggedErrorClass<InferenceUnavailableError>()(
  "InferenceUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class InferenceInternalServerError extends Schema.TaggedErrorClass<InferenceInternalServerError>()(
  "InferenceInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

// ---------------------------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------------------------

export const InferenceGroup = HttpApiGroup.make("inference")
  .add(
    HttpApiEndpoint.post("respond", "/respond", {
      payload: inferenceRespondRequestSchema,
      success: inferenceRespondResponseSchema.pipe(HttpApiSchema.status(200)),
      error: [
        InferenceBadRequestError,
        InferenceNotFoundError,
        InferenceConflictError,
        InferenceUnavailableError,
        InferenceInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Inference on connected accounts, via the official agent SDKs — never raw model-API calls.",
  );
