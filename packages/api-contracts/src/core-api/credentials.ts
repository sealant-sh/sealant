import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const credentialProviderSchema = Schema.Literals(["github", "claude", "codex"]);
export type CredentialProvider = typeof credentialProviderSchema.Type;

export const credentialKindSchema = Schema.Literals(["oauth", "api_key", "session_file"]);
export type CredentialKind = typeof credentialKindSchema.Type;

export const credentialPayloadShapeSchema = Schema.Literals([
  "oauth_token_set",
  "api_key",
  "raw_file",
]);
export type CredentialPayloadShape = typeof credentialPayloadShapeSchema.Type;

export const credentialStatusSchema = Schema.Literals(["active", "needs_reauth", "revoked"]);
export type CredentialStatus = typeof credentialStatusSchema.Type;

/** Connect (store) a credential. The plaintext `secret` is encrypted server-side; only metadata is returned. */
export const connectCredentialRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  provider: credentialProviderSchema,
  kind: credentialKindSchema,
  payloadShape: credentialPayloadShapeSchema,
  /** The raw token, api key, or credential-file contents to encrypt at rest. */
  secret: NonEmptyString,
  label: Schema.optional(NonEmptyString),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  accountIdentifier: Schema.optional(NonEmptyString),
  /** ISO-8601 expiry, when known. */
  expiresAt: Schema.optional(Schema.String),
});
export type ConnectCredentialRequest = typeof connectCredentialRequestSchema.Type;

/** Metadata view of a credential — never includes the secret bytes. */
export const credentialMetadataSchema = Schema.Struct({
  id: NonEmptyString,
  ownerUserId: NonEmptyString,
  provider: credentialProviderSchema,
  kind: credentialKindSchema,
  status: credentialStatusSchema,
  label: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  accountIdentifier: Schema.optional(Schema.String),
  last4: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  connectedAt: Schema.String,
  lastRefreshedAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
  rotationCount: Schema.Number,
});
export type CredentialMetadata = typeof credentialMetadataSchema.Type;

export const listCredentialsQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type ListCredentialsQuery = typeof listCredentialsQuerySchema.Type;

export const listCredentialsResponseSchema = Schema.Struct({
  items: Schema.Array(credentialMetadataSchema),
});
export type ListCredentialsResponse = typeof listCredentialsResponseSchema.Type;

const credentialIdParams = Schema.Struct({ credentialId: NonEmptyString });

export class CredentialBadRequestError extends Schema.TaggedErrorClass<CredentialBadRequestError>()(
  "CredentialBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class CredentialNotFoundError extends Schema.TaggedErrorClass<CredentialNotFoundError>()(
  "CredentialNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class CredentialInternalServerError extends Schema.TaggedErrorClass<CredentialInternalServerError>()(
  "CredentialInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export const CredentialsGroup = HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.post("connectCredential", "/", {
      payload: connectCredentialRequestSchema,
      success: credentialMetadataSchema.pipe(HttpApiSchema.status(201)),
      error: [CredentialBadRequestError, CredentialInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listCredentials", "/", {
      query: listCredentialsQuerySchema,
      success: listCredentialsResponseSchema,
      error: [CredentialBadRequestError, CredentialInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getCredential", "/:credentialId", {
      params: credentialIdParams,
      query: listCredentialsQuerySchema,
      success: credentialMetadataSchema,
      error: [CredentialNotFoundError, CredentialInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeCredential", "/:credentialId/revoke", {
      params: credentialIdParams,
      query: listCredentialsQuerySchema,
      success: credentialMetadataSchema,
      error: [CredentialNotFoundError, CredentialInternalServerError],
    }),
  )
  .annotate(OpenApi.Description, "Store, list, and revoke a principal's forwarded tool credentials.");
