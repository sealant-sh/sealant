import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

/*
User SSH public keys. Two audiences:
- the web app (via its tRPC proxy) registers/lists/archives keys for the logged-in user;
- the SSH gateway resolves an offered key to its owning principal at auth time via
  `resolveSshPrincipal`, gated by the shared gateway token (same trust model as
  `getSandboxSshTarget` in sandboxes.ts).
*/

export const sshKeyGatewayHeadersSchema = Schema.Struct({
  // Authenticates the gateway as a trusted caller of the internal resolve endpoint.
  "x-sealant-gateway-token": Schema.optional(NonEmptyString),
});
export type SshKeyGatewayHeaders = typeof sshKeyGatewayHeadersSchema.Type;

export const createSshKeyRequestSchema = Schema.Struct({
  // Same trust model as createSandbox: the internal API trusts the caller-supplied owner; the web
  // server injects the session user id.
  ownerUserId: NonEmptyString,
  name: Schema.optional(NonEmptyString),
  // Raw `<algorithm> <base64> [comment]` line; the API normalizes and fingerprints it.
  publicKey: NonEmptyString,
});
export type CreateSshKeyRequest = typeof createSshKeyRequestSchema.Type;

export const sshKeySummarySchema = Schema.Struct({
  sshKeyId: NonEmptyString,
  ownerUserId: NonEmptyString,
  name: NonEmptyString,
  algorithm: NonEmptyString,
  fingerprint: NonEmptyString,
  createdAt: Schema.String,
});
export type SshKeySummary = typeof sshKeySummarySchema.Type;

export const listSshKeysQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});

export const listSshKeysResponseSchema = Schema.Struct({
  items: Schema.Array(sshKeySummarySchema),
});
export type ListSshKeysResponse = typeof listSshKeysResponseSchema.Type;

export const resolveSshPrincipalRequestSchema = Schema.Struct({
  // ctx.key.algo / base64(ctx.key.data) from the gateway's ssh2 auth context. The API recomputes
  // the fingerprint server-side; callers never supply one.
  algo: NonEmptyString,
  publicKeyBase64: NonEmptyString,
});
export type ResolveSshPrincipalRequest = typeof resolveSshPrincipalRequestSchema.Type;

export const resolveSshPrincipalResponseSchema = Schema.Struct({
  principalId: NonEmptyString,
  sshKeyId: NonEmptyString,
  fingerprint: NonEmptyString,
});
export type ResolveSshPrincipalResponse = typeof resolveSshPrincipalResponseSchema.Type;

export class SshKeyBadRequestError extends Schema.TaggedErrorClass<SshKeyBadRequestError>()(
  "SshKeyBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class SshKeyUnauthorizedError extends Schema.TaggedErrorClass<SshKeyUnauthorizedError>()(
  "SshKeyUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class SshKeyNotFoundError extends Schema.TaggedErrorClass<SshKeyNotFoundError>()(
  "SshKeyNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SshKeyConflictError extends Schema.TaggedErrorClass<SshKeyConflictError>()(
  "SshKeyConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class SshKeyServiceUnavailableError extends Schema.TaggedErrorClass<SshKeyServiceUnavailableError>()(
  "SshKeyServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class SshKeyInternalServerError extends Schema.TaggedErrorClass<SshKeyInternalServerError>()(
  "SshKeyInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const sshKeyIdParams = Schema.Struct({ sshKeyId: NonEmptyString });

export const SshKeysGroup = HttpApiGroup.make("sshKeys")
  .add(
    HttpApiEndpoint.post("createSshKey", "/", {
      payload: createSshKeyRequestSchema,
      success: sshKeySummarySchema.pipe(HttpApiSchema.status(201)),
      error: [
        SshKeyBadRequestError,
        SshKeyNotFoundError,
        SshKeyConflictError,
        SshKeyInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSshKeys", "/", {
      query: listSshKeysQuerySchema,
      success: listSshKeysResponseSchema,
      error: [SshKeyInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("archiveSshKey", "/:sshKeyId", {
      params: sshKeyIdParams,
      query: listSshKeysQuerySchema,
      success: sshKeySummarySchema,
      error: [SshKeyNotFoundError, SshKeyInternalServerError],
    }),
  )
  .add(
    // POST (not GET) so key material stays out of URLs and access logs.
    HttpApiEndpoint.post("resolveSshPrincipal", "/resolve-principal", {
      headers: sshKeyGatewayHeadersSchema,
      payload: resolveSshPrincipalRequestSchema,
      success: resolveSshPrincipalResponseSchema,
      error: [
        SshKeyUnauthorizedError,
        SshKeyNotFoundError,
        SshKeyServiceUnavailableError,
        SshKeyInternalServerError,
      ],
    }),
  )
  .annotate(OpenApi.Description, "User SSH public keys and gateway principal resolution.");
