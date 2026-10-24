import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

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

Each person has at most one default account per provider, the one the selector `default` (the
SDK's `true`) means. Connecting a person's first account for a provider makes it the default;
after that only `makeDefault` on a connect, or `setConnectedAccountDefault`, changes it.
Disconnecting the default leaves the person without one: no other account is chosen for them.
*/

export const connectedAccountProviderSchema = Schema.Literals(["claude", "codex", "github"]);
export type ConnectedAccountProvider = typeof connectedAccountProviderSchema.Type;

export const connectedAccountStatusSchema = Schema.Literals(["active", "invalid", "archived"]);
export type ConnectedAccountStatus = typeof connectedAccountStatusSchema.Type;

/**
 * What the control plane observed about a credential's life, so a consumer can say "expired" as an
 * observation instead of parsing a payload it must never see. Every field is null when nothing was
 * observed: a setup token has no expiry, a row connected before this shipped has no stored one, and
 * an account that has never been swept has no refresh outcome.
 */
export const connectedAccountCredentialSchema = Schema.Struct({
  /** When the access token expires. Hours, for a Claude session credential. */
  accessExpiresAt: Schema.NullOr(Schema.String),
  /** When the grant itself expires, after which reconnecting is the only way back. */
  refreshExpiresAt: Schema.NullOr(Schema.String),
  /** When the platform last rotated or checked this credential. */
  lastRefreshAt: Schema.NullOr(Schema.String),
  /** What that attempt did: `refreshed`, `fresh` (nothing to do), or `failed`. */
  lastRefreshOutcome: Schema.NullOr(Schema.Literals(["refreshed", "fresh", "failed"])),
});
export type ConnectedAccountCredential = typeof connectedAccountCredentialSchema.Type;

export const connectedAccountSummarySchema = Schema.Struct({
  connectedAccountId: NonEmptyString,
  ownerUserId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  name: NonEmptyString,
  // "oauth-token" | "credentials-json" (claude) | "auth-json" (codex) | "gh-cli-token" (github).
  kind: NonEmptyString,
  status: connectedAccountStatusSchema,
  // NON-secret display/ops data (claude token suffix, codex account id/email, github login+scopes).
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  connectedAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  /** Freshness as the control plane observed it; see the schema above for what null means. */
  credential: connectedAccountCredentialSchema,
  /** Whether this is the owner's default for its provider. Absent from older control planes. */
  isDefault: Schema.optional(Schema.Boolean),
  /**
   * Which credential the account holds: starts at 1 and moves on whenever a reconnect or refresh
   * stores different bytes. Absent from older control planes.
   */
  credentialRevision: Schema.optional(Schema.Int),
});
export type ConnectedAccountSummary = typeof connectedAccountSummarySchema.Type;

export const createConnectedAccountRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  /**
   * The account to connect or replace by name; a new name is a new account, and `default` names
   * the owner's chosen default. The owner's first account for the provider is named `default`
   * whatever this says. With neither `name` nor `accountId` (or `default` while none is chosen),
   * the owner's only account is replaced, and with several the connect is refused (`409`,
   * `connected-account-ambiguous`, with `candidateAccountIds`).
   */
  name: Schema.optional(NonEmptyString),
  /** Replace this account (the owner's, of `provider`). Not with `name`. */
  accountId: Schema.optional(NonEmptyString),
  /** Make the connected account the owner's default for the provider, in the same write. */
  makeDefault: Schema.optional(Schema.Boolean),
  // Provider-shaped plaintext: claude setup-token or verbatim .credentials.json contents /
  // verbatim codex auth.json contents / github token. Encrypted server-side; never stored or
  // echoed back as-is. Not trimmed here — pasted credential files are stored verbatim.
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
  /**
   * The `credentialRevision` the refusal was observed on. When the stored credential has moved on
   * since, nothing is marked and the answer's `outcome` is `superseded`.
   */
  revision: Schema.optional(Schema.Int),
});
export type MarkConnectedAccountInvalidRequest =
  typeof markConnectedAccountInvalidRequestSchema.Type;

export const markConnectedAccountInvalidResponseSchema = Schema.Struct({
  ...connectedAccountSummarySchema.fields,
  /** `marked`: the account is now invalid. `superseded`: a newer credential, left as it was. */
  outcome: Schema.optional(Schema.Literals(["marked", "superseded"])),
});
export type MarkConnectedAccountInvalidResponse =
  typeof markConnectedAccountInvalidResponseSchema.Type;

export const setConnectedAccountDefaultRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  connectedAccountId: NonEmptyString,
});
export type SetConnectedAccountDefaultRequest = typeof setConnectedAccountDefaultRequestSchema.Type;

export class ConnectedAccountBadRequestError extends Schema.TaggedError<ConnectedAccountBadRequestError>()(
  "ConnectedAccountBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class ConnectedAccountNotFoundError extends Schema.TaggedError<ConnectedAccountNotFoundError>()(
  "ConnectedAccountNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ConnectedAccountConflictError extends Schema.TaggedError<ConnectedAccountConflictError>()(
  "ConnectedAccountConflictError",
  {
    message: Schema.String,
    /**
     * A stable reason, where one applies: `connected-account-ambiguous` (a connect without a target
     * while the owner has several accounts for the provider), `connected-account-invalid` (a default
     * chosen while its credential is invalid).
     */
    code: Schema.optional(
      Schema.Literals(["connected-account-ambiguous", "connected-account-invalid"]),
    ),
    /** The accounts a `connected-account-ambiguous` connect could have meant. */
    candidateAccountIds: Schema.optional(Schema.Array(NonEmptyString)),
  },
  { httpApiStatus: 409 },
) {}

export class ConnectedAccountServiceUnavailableError extends Schema.TaggedError<ConnectedAccountServiceUnavailableError>()(
  "ConnectedAccountServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class ConnectedAccountInternalServerError extends Schema.TaggedError<ConnectedAccountInternalServerError>()(
  "ConnectedAccountInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const connectedAccountIdParams = Schema.Struct({ connectedAccountId: NonEmptyString });
const connectedAccountProviderParams = Schema.Struct({ provider: connectedAccountProviderSchema });

export const ConnectedAccountsGroup = HttpApiGroup.make("connectedAccounts")
  .add(
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
      success: markConnectedAccountInvalidResponseSchema,
      error: [ConnectedAccountNotFoundError, ConnectedAccountInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.put("setConnectedAccountDefault", "/defaults/:provider", {
      params: connectedAccountProviderParams,
      payload: setConnectedAccountDefaultRequestSchema,
      success: connectedAccountSummarySchema,
      error: [
        ConnectedAccountNotFoundError,
        ConnectedAccountConflictError,
        ConnectedAccountInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Connected provider accounts (Claude / Codex / GitHub credentials). Secret material is never returned by any endpoint.",
  );
