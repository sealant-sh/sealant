import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

/*
Connected provider accounts (Claude / Codex / GitHub credentials). Same trust model as ssh-keys:
the internal API trusts the caller-supplied `ownerUserId`; the web tRPC proxy and the CLI inject
the session/configured user inside the deployment's trust boundary.

Secret material flows exactly one way: `createConnectedAccountRequestSchema.secret` carries the
provider-shaped plaintext INTO the API, where it is validated, encrypted (AES-256-GCM via
@sealant/credentials), and stored sealed. NO endpoint ever returns secret material — summaries
expose only non-secret metadata (token suffix, codex account id/email, github login+scopes).
`markConnectedAccountInvalid` is the internal 401-feedback hook (worker/sync-back observed the
provider rejecting the credential).
*/

export const connectedAccountProviderSchema = Schema.Literals(["claude", "codex", "github"]);
export type ConnectedAccountProvider = typeof connectedAccountProviderSchema.Type;

export const connectedAccountStatusSchema = Schema.Literals(["active", "invalid", "archived"]);
export type ConnectedAccountStatus = typeof connectedAccountStatusSchema.Type;

export const connectedAccountSummarySchema = Schema.Struct({
  connectedAccountId: NonEmptyString,
  ownerUserId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  name: NonEmptyString,
  // "oauth-token" (claude) | "auth-json" (codex) | "gh-cli-token" (github).
  kind: NonEmptyString,
  status: connectedAccountStatusSchema,
  // NON-secret display/ops data (claude token suffix, codex account id/email, github login+scopes).
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  connectedAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
});
export type ConnectedAccountSummary = typeof connectedAccountSummarySchema.Type;

export const createConnectedAccountRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  // Multiple accounts per provider are allowed; defaults to "default".
  name: Schema.optional(NonEmptyString),
  // Provider-shaped plaintext: claude setup-token / verbatim codex auth.json contents / github
  // token. Encrypted server-side; never stored or echoed back as-is. Not trimmed here — codex
  // auth.json is stored verbatim.
  secret: Schema.String.check(Schema.isNonEmpty()),
});
export type CreateConnectedAccountRequest = typeof createConnectedAccountRequestSchema.Type;

export const listConnectedAccountsQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type ListConnectedAccountsQuery = typeof listConnectedAccountsQuerySchema.Type;

export const listConnectedAccountsResponseSchema = Schema.Struct({
  items: Schema.Array(connectedAccountSummarySchema),
});
export type ListConnectedAccountsResponse = typeof listConnectedAccountsResponseSchema.Type;

export const markConnectedAccountInvalidRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type MarkConnectedAccountInvalidRequest =
  typeof markConnectedAccountInvalidRequestSchema.Type;

export class ConnectedAccountBadRequestError extends Schema.TaggedErrorClass<ConnectedAccountBadRequestError>()(
  "ConnectedAccountBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class ConnectedAccountNotFoundError extends Schema.TaggedErrorClass<ConnectedAccountNotFoundError>()(
  "ConnectedAccountNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ConnectedAccountConflictError extends Schema.TaggedErrorClass<ConnectedAccountConflictError>()(
  "ConnectedAccountConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class ConnectedAccountServiceUnavailableError extends Schema.TaggedErrorClass<ConnectedAccountServiceUnavailableError>()(
  "ConnectedAccountServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class ConnectedAccountInternalServerError extends Schema.TaggedErrorClass<ConnectedAccountInternalServerError>()(
  "ConnectedAccountInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const connectedAccountIdParams = Schema.Struct({ connectedAccountId: NonEmptyString });

export const ConnectedAccountsGroup = HttpApiGroup.make("connectedAccounts")
  .add(
    // Connect/replace: upserts on (owner, provider, name), so reconnecting swaps the sealed
    // payload in place instead of erroring.
    HttpApiEndpoint.post("createConnectedAccount", "/", {
      payload: createConnectedAccountRequestSchema,
      success: connectedAccountSummarySchema.pipe(HttpApiSchema.status(201)),
      error: [
        ConnectedAccountBadRequestError,
        ConnectedAccountNotFoundError,
        ConnectedAccountConflictError,
        ConnectedAccountServiceUnavailableError,
        ConnectedAccountInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listConnectedAccounts", "/", {
      query: listConnectedAccountsQuerySchema,
      success: listConnectedAccountsResponseSchema,
      error: [ConnectedAccountInternalServerError],
    }),
  )
  .add(
    // Soft archive; uniform 404 for "does not exist" and "not yours".
    HttpApiEndpoint.delete("archiveConnectedAccount", "/:connectedAccountId", {
      params: connectedAccountIdParams,
      query: listConnectedAccountsQuerySchema,
      success: connectedAccountSummarySchema,
      error: [ConnectedAccountNotFoundError, ConnectedAccountInternalServerError],
    }),
  )
  .add(
    // Internal feedback hook: the worker observed the provider rejecting this credential (401),
    // so surfaces should prompt a re-auth.
    HttpApiEndpoint.post("markConnectedAccountInvalid", "/:connectedAccountId/mark-invalid", {
      params: connectedAccountIdParams,
      payload: markConnectedAccountInvalidRequestSchema,
      success: connectedAccountSummarySchema,
      error: [ConnectedAccountNotFoundError, ConnectedAccountInternalServerError],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Connected provider accounts (Claude / Codex / GitHub credentials). Secret material is never returned by any endpoint.",
  );
