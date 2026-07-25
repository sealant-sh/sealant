/**
 * Access-token wire contracts — scoped bearer tokens for the session surface.
 *
 * Scopes are the enforcement primitive a pairing flow mints against: `session:read`
 * (stream/status/output), `session:input` (input/resize/signal), `workspace:exec` (open
 * sessions/terminals, exec). The secret is returned ONCE at mint; only its SHA-256 hash is
 * stored. Minting rides the pre-auth owner model like every other endpoint today — the value of
 * the scopes is DOWNSTREAM enforcement (a leaked read-stream token cannot send input or exec).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const accessTokenScopeSchema = Schema.Literals([
  "session:read",
  "session:input",
  "workspace:exec",
]);
export type AccessTokenScopeWire = typeof accessTokenScopeSchema.Type;

export const createAccessTokenRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  scopes: Schema.Array(accessTokenScopeSchema).check(Schema.isNonEmpty()),
  name: Schema.optional(NonEmptyString),
  /** When set, the token is valid only for this workspace. */
  workspaceId: Schema.optional(NonEmptyString),
  /** Seconds until the token expires; omitted = no expiry. */
  ttlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type CreateAccessTokenRequest = typeof createAccessTokenRequestSchema.Type;

export const accessTokenSchema = Schema.Struct({
  tokenId: NonEmptyString,
  ownerUserId: NonEmptyString,
  name: Schema.optional(NonEmptyString),
  scopes: Schema.Array(accessTokenScopeSchema),
  workspaceId: Schema.optional(NonEmptyString),
  expiresAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
export type AccessTokenWire = typeof accessTokenSchema.Type;

export const createAccessTokenResponseSchema = Schema.Struct({
  ...accessTokenSchema.fields,
  /** The bearer secret (`slt_...`). Shown exactly once — it is never stored or retrievable. */
  token: NonEmptyString,
});
export type CreateAccessTokenResponse = typeof createAccessTokenResponseSchema.Type;

export const listAccessTokensQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type ListAccessTokensQuery = typeof listAccessTokensQuerySchema.Type;

export const listAccessTokensResponseSchema = Schema.Struct({
  items: Schema.Array(accessTokenSchema),
});
export type ListAccessTokensResponse = typeof listAccessTokensResponseSchema.Type;

export class AccessTokenBadRequestError extends Schema.TaggedErrorClass<AccessTokenBadRequestError>()(
  "AccessTokenBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class AccessTokenNotFoundError extends Schema.TaggedErrorClass<AccessTokenNotFoundError>()(
  "AccessTokenNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class AccessTokenInternalServerError extends Schema.TaggedErrorClass<AccessTokenInternalServerError>()(
  "AccessTokenInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const tokenIdParams = Schema.Struct({ tokenId: NonEmptyString });

export const AccessTokensGroup = HttpApiGroup.make("accessTokens")
  .add(
    HttpApiEndpoint.post("createAccessToken", "/", {
      payload: createAccessTokenRequestSchema,
      success: createAccessTokenResponseSchema.pipe(HttpApiSchema.status(201)),
      error: [AccessTokenBadRequestError, AccessTokenNotFoundError, AccessTokenInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listAccessTokens", "/", {
      query: listAccessTokensQuerySchema,
      success: listAccessTokensResponseSchema,
      error: [AccessTokenBadRequestError, AccessTokenInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeAccessToken", "/:tokenId/revoke", {
      params: tokenIdParams,
      payload: Schema.Struct({ ownerUserId: NonEmptyString }),
      success: accessTokenSchema,
      error: [AccessTokenBadRequestError, AccessTokenNotFoundError, AccessTokenInternalServerError],
    }),
  )
  .annotate(OpenApi.Description, "Scoped bearer tokens for the session surface.");
