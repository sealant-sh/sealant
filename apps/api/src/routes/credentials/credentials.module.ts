import { randomUUID } from "node:crypto";

import {
  CredentialInternalServerError,
  CredentialNotFoundError,
  type ConnectCredentialRequest,
  type CredentialMetadata,
  type ListCredentialsQuery,
  type ListCredentialsResponse,
} from "@sealant/api-contracts";
import {
  PrincipalCredentialRepo,
  encryptEnvelope,
  makeEnvKeyProvider,
  valueSha256,
  type KeyProvider,
  type PrincipalCredential,
} from "@sealant/db";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";

/** Map any repository/unexpected failure into the API's 500. */
const withInternalError = <A>(effect: Effect.Effect<A, unknown>, message: string) =>
  effect.pipe(Effect.mapError(() => new CredentialInternalServerError({ message })));

/** Build the envelope key provider, surfacing a clear 500 when the store key is not configured. */
const getKeyProvider = (): Effect.Effect<KeyProvider, CredentialInternalServerError> =>
  Effect.try({
    try: () => makeEnvKeyProvider(env.SEALANT_SECRETS_KEY),
    catch: () =>
      new CredentialInternalServerError({
        message: "Credential store is not configured (set SEALANT_SECRETS_KEY).",
      }),
  });

const isoOrUndefined = (date: Date | null): string | undefined =>
  date === null ? undefined : date.toISOString();

/** Project a stored credential row onto the metadata response — never includes secret bytes. */
const toMetadata = (c: PrincipalCredential): CredentialMetadata => ({
  id: c.id,
  ownerUserId: c.ownerUserId,
  provider: c.provider,
  kind: c.kind,
  status: c.status,
  rotationCount: c.rotationCount,
  connectedAt: c.connectedAt.toISOString(),
  ...(c.label === null ? {} : { label: c.label }),
  ...(c.scopes === null ? {} : { scopes: c.scopes }),
  ...(c.accountIdentifier === null ? {} : { accountIdentifier: c.accountIdentifier }),
  ...(c.last4 === null ? {} : { last4: c.last4 }),
  ...(c.expiresAt === null ? {} : { expiresAt: c.expiresAt.toISOString() }),
  ...(isoOrUndefined(c.lastRefreshedAt) === undefined
    ? {}
    : { lastRefreshedAt: c.lastRefreshedAt!.toISOString() }),
  ...(isoOrUndefined(c.lastUsedAt) === undefined
    ? {}
    : { lastUsedAt: c.lastUsedAt!.toISOString() }),
});

export const connectCredential = (payload: ConnectCredentialRequest) =>
  Effect.gen(function* () {
    const keyProvider = yield* getKeyProvider();
    const id = `pcred_${randomUUID()}`;
    const versionId = `pcredv_${randomUUID()}`;
    const aad = `${payload.ownerUserId}:${id}`;
    const envelope = encryptEnvelope(payload.secret, aad, keyProvider);
    const repo = yield* PrincipalCredentialRepo;

    const credential = yield* withInternalError(
      repo.connectCredential({
        id,
        ownerUserId: payload.ownerUserId,
        provider: payload.provider,
        kind: payload.kind,
        versionId,
        envelope,
        kekId: keyProvider.id,
        valueSha256: valueSha256(payload.secret),
        payloadShape: payload.payloadShape,
        // Display hint only — last 4 chars of the secret, never the secret.
        last4: payload.secret.slice(-4),
        ...(payload.label === undefined ? {} : { label: payload.label }),
        ...(payload.scopes === undefined ? {} : { scopes: payload.scopes }),
        ...(payload.accountIdentifier === undefined
          ? {}
          : { accountIdentifier: payload.accountIdentifier }),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: new Date(payload.expiresAt) }),
      }),
      "Failed to store credential.",
    );

    return toMetadata(credential);
  });

export const listCredentials = (query: ListCredentialsQuery) =>
  Effect.gen(function* () {
    const repo = yield* PrincipalCredentialRepo;
    const credentials = yield* withInternalError(
      repo.listByOwner(query.ownerUserId),
      "Failed to list credentials.",
    );
    return { items: credentials.map(toMetadata) } satisfies ListCredentialsResponse;
  });

export const getCredential = (input: { credentialId: string; query: ListCredentialsQuery }) =>
  Effect.gen(function* () {
    const repo = yield* PrincipalCredentialRepo;
    const credential = yield* withInternalError(
      repo.getByIdForOwner({ ownerUserId: input.query.ownerUserId, id: input.credentialId }),
      "Failed to load credential.",
    );
    if (credential === undefined) {
      return yield* new CredentialNotFoundError({ message: "Credential not found." });
    }
    return toMetadata(credential);
  });

export const revokeCredential = (input: { credentialId: string; query: ListCredentialsQuery }) =>
  Effect.gen(function* () {
    const repo = yield* PrincipalCredentialRepo;
    const credential = yield* withInternalError(
      repo.revoke({ ownerUserId: input.query.ownerUserId, id: input.credentialId }),
      "Failed to revoke credential.",
    );
    if (credential === null) {
      return yield* new CredentialNotFoundError({ message: "Credential not found." });
    }
    return toMetadata(credential);
  });
