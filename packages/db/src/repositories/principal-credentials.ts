import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB, type DB } from "../client.js";
import {
  principalCredentials,
  principalCredentialVersions,
  type NewPrincipalCredential,
  type NewPrincipalCredentialVersion,
  type PrincipalCredential,
  type PrincipalCredentialKind,
  type PrincipalCredentialPayloadShape,
  type PrincipalCredentialProvider,
  type PrincipalCredentialVersion,
} from "../schema.js";

/** A connected credential plus its active encrypted version — what the worker resolver decrypts. */
export interface ResolvedCredential {
  readonly credential: PrincipalCredential;
  readonly version: PrincipalCredentialVersion;
}

/** Connect a credential: insert the metadata row + version 1 (ciphertext supplied pre-encrypted). */
export interface ConnectCredentialInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly provider: PrincipalCredentialProvider;
  readonly kind: PrincipalCredentialKind;
  readonly label?: string;
  readonly scopes?: readonly string[];
  readonly accountIdentifier?: string;
  readonly last4?: string;
  readonly expiresAt?: Date;
  readonly tokenFamily?: string;
  // Version-1 material (already encrypted by the caller via the crypto module):
  readonly versionId: string;
  readonly envelope: string;
  readonly kekId: string;
  readonly valueSha256: string;
  readonly payloadShape: PrincipalCredentialPayloadShape;
  readonly createdByUserId?: string;
}

/** Add a fresh version to an existing credential (token refresh write-back). */
export interface AddCredentialVersionInput {
  readonly credentialId: string;
  readonly ownerUserId: string;
  readonly versionId: string;
  readonly envelope: string;
  readonly kekId: string;
  readonly valueSha256: string;
  readonly payloadShape: PrincipalCredentialPayloadShape;
  readonly expiresAt?: Date | null;
  readonly scopes?: readonly string[];
  readonly createdByUserId?: string;
}

const principalCredentialRepoOperationSchema = Schema.Literals([
  "connectCredential",
  "addVersion",
  "getActiveVersionForResolve",
  "getByIdForOwner",
  "listByOwner",
  "revoke",
  "markNeedsReauth",
  "recordUsage",
]);

type PrincipalCredentialRepoOperation = typeof principalCredentialRepoOperationSchema.Type;

export class PrincipalCredentialRepoInvariantError extends Schema.TaggedErrorClass<PrincipalCredentialRepoInvariantError>()("PrincipalCredentialRepoInvariantError", {
  operation: principalCredentialRepoOperationSchema,
  message: Schema.String,
}) {}

export class PrincipalCredentialRepoUnexpectedError extends Schema.TaggedErrorClass<PrincipalCredentialRepoUnexpectedError>()("PrincipalCredentialRepoUnexpectedError", {
  operation: principalCredentialRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const principalCredentialRepoErrorSchema = Schema.Union([
  PrincipalCredentialRepoInvariantError,
  PrincipalCredentialRepoUnexpectedError,
]);

export type PrincipalCredentialRepoError = typeof principalCredentialRepoErrorSchema.Type;

const mapError = (
  operation: PrincipalCredentialRepoOperation,
  cause: unknown,
): PrincipalCredentialRepoError => {
  if (
    cause instanceof PrincipalCredentialRepoInvariantError ||
    cause instanceof PrincipalCredentialRepoUnexpectedError
  ) {
    return cause;
  }
  return new PrincipalCredentialRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withError = <A>(
  operation: PrincipalCredentialRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, PrincipalCredentialRepoError> =>
  effect.pipe(Effect.mapError((cause) => mapError(operation, cause)));

export interface PrincipalCredentialRepoService {
  readonly connectCredential: (
    input: ConnectCredentialInput,
  ) => Effect.Effect<PrincipalCredential, PrincipalCredentialRepoError>;
  readonly addVersion: (
    input: AddCredentialVersionInput,
  ) => Effect.Effect<PrincipalCredential, PrincipalCredentialRepoError>;
  /** Resolve a credential by id, re-scoped to its owner, with its active version. `undefined` if absent/not-owned. */
  readonly getActiveVersionForResolve: (input: {
    readonly ownerUserId: string;
    readonly credentialId: string;
  }) => Effect.Effect<ResolvedCredential | undefined, PrincipalCredentialRepoError>;
  readonly getByIdForOwner: (input: {
    readonly ownerUserId: string;
    readonly id: string;
  }) => Effect.Effect<PrincipalCredential | undefined, PrincipalCredentialRepoError>;
  readonly listByOwner: (
    ownerUserId: string,
  ) => Effect.Effect<readonly PrincipalCredential[], PrincipalCredentialRepoError>;
  /** Revoke a credential and crypto-shred its versions (delete the ciphertext). */
  readonly revoke: (input: {
    readonly ownerUserId: string;
    readonly id: string;
  }) => Effect.Effect<PrincipalCredential | null, PrincipalCredentialRepoError>;
  readonly markNeedsReauth: (input: {
    readonly ownerUserId: string;
    readonly id: string;
  }) => Effect.Effect<PrincipalCredential | null, PrincipalCredentialRepoError>;
  readonly recordUsage: (
    id: string,
  ) => Effect.Effect<void, PrincipalCredentialRepoError>;
}

export class PrincipalCredentialRepo extends Context.Service<
  PrincipalCredentialRepo,
  PrincipalCredentialRepoService
>()("PrincipalCredentialRepo") {}

/** Look up an owner-scoped credential row via any executor (the DB handle or a transaction). */
const findOwnedCredential = (
  executor: Pick<DB, "select">,
  ownerUserId: string,
  id: string,
): Effect.Effect<PrincipalCredential | undefined, unknown> =>
  Effect.gen(function* () {
    const [row] = yield* executor
      .select()
      .from(principalCredentials)
      .where(
        and(eq(principalCredentials.id, id), eq(principalCredentials.ownerUserId, ownerUserId)),
      )
      .limit(1);
    return row;
  });

export const PrincipalCredentialRepoLive = Layer.effect(
  PrincipalCredentialRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      connectCredential: (input) =>
        withError(
          "connectCredential",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [credential] = yield* tx
                .insert(principalCredentials)
                .values({
                  id: input.id,
                  ownerUserId: input.ownerUserId,
                  provider: input.provider,
                  kind: input.kind,
                  status: "active",
                  currentVersionId: input.versionId,
                  ...(input.label === undefined ? {} : { label: input.label }),
                  ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
                  ...(input.accountIdentifier === undefined
                    ? {}
                    : { accountIdentifier: input.accountIdentifier }),
                  ...(input.last4 === undefined ? {} : { last4: input.last4 }),
                  ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
                  ...(input.tokenFamily === undefined ? {} : { tokenFamily: input.tokenFamily }),
                } satisfies NewPrincipalCredential)
                .returning();

              if (credential === undefined) {
                return yield* new PrincipalCredentialRepoInvariantError({
                  operation: "connectCredential",
                  message: "Failed to insert credential.",
                });
              }

              yield* tx.insert(principalCredentialVersions).values({
                id: input.versionId,
                credentialId: input.id,
                version: 1,
                envelope: input.envelope,
                kekId: input.kekId,
                valueSha256: input.valueSha256,
                payloadShape: input.payloadShape,
                ...(input.createdByUserId === undefined
                  ? {}
                  : { createdByUserId: input.createdByUserId }),
              } satisfies NewPrincipalCredentialVersion);

              return credential;
            }),
          ),
        ),

      addVersion: (input) =>
        withError(
          "addVersion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* findOwnedCredential(tx, input.ownerUserId, input.credentialId);
              if (credential === undefined) {
                return yield* new PrincipalCredentialRepoInvariantError({
                  operation: "addVersion",
                  message: "Credential not found for owner.",
                });
              }

              const [latest] = yield* tx
                .select({ version: principalCredentialVersions.version })
                .from(principalCredentialVersions)
                .where(eq(principalCredentialVersions.credentialId, input.credentialId))
                .orderBy(desc(principalCredentialVersions.version))
                .limit(1);
              const nextVersion = (latest?.version ?? 0) + 1;

              yield* tx.insert(principalCredentialVersions).values({
                id: input.versionId,
                credentialId: input.credentialId,
                version: nextVersion,
                envelope: input.envelope,
                kekId: input.kekId,
                valueSha256: input.valueSha256,
                payloadShape: input.payloadShape,
                ...(input.createdByUserId === undefined
                  ? {}
                  : { createdByUserId: input.createdByUserId }),
              } satisfies NewPrincipalCredentialVersion);

              const [updated] = yield* tx
                .update(principalCredentials)
                .set({
                  currentVersionId: input.versionId,
                  rotationCount: credential.rotationCount + 1,
                  lastRefreshedAt: new Date(),
                  status: "active",
                  ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
                  ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
                })
                .where(eq(principalCredentials.id, input.credentialId))
                .returning();

              return updated ?? credential;
            }),
          ),
        ),

      getActiveVersionForResolve: (input) =>
        withError(
          "getActiveVersionForResolve",
          Effect.gen(function* () {
            const [credential] = yield* db
              .select()
              .from(principalCredentials)
              .where(
                and(
                  eq(principalCredentials.id, input.credentialId),
                  eq(principalCredentials.ownerUserId, input.ownerUserId),
                  eq(principalCredentials.status, "active"),
                ),
              )
              .limit(1);
            if (credential === undefined || credential.currentVersionId === null) {
              return undefined;
            }
            const [version] = yield* db
              .select()
              .from(principalCredentialVersions)
              .where(eq(principalCredentialVersions.id, credential.currentVersionId))
              .limit(1);
            if (version === undefined) {
              return undefined;
            }
            return { credential, version } satisfies ResolvedCredential;
          }),
        ),

      getByIdForOwner: (input) =>
        withError(
          "getByIdForOwner",
          Effect.gen(function* () {
            return yield* findOwnedCredential(db, input.ownerUserId, input.id);
          }),
        ),

      listByOwner: (ownerUserId) =>
        withError(
          "listByOwner",
          Effect.gen(function* () {
            return yield* db
              .select()
              .from(principalCredentials)
              .where(
                and(
                  eq(principalCredentials.ownerUserId, ownerUserId),
                  isNull(principalCredentials.revokedAt),
                ),
              )
              .orderBy(desc(principalCredentials.connectedAt));
          }),
        ),

      revoke: (input) =>
        withError(
          "revoke",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const credential = yield* findOwnedCredential(tx, input.ownerUserId, input.id);
              if (credential === undefined) {
                return null;
              }
              // Crypto-shred: delete the ciphertext versions so the value is unrecoverable.
              yield* tx
                .delete(principalCredentialVersions)
                .where(eq(principalCredentialVersions.credentialId, input.id));
              const [updated] = yield* tx
                .update(principalCredentials)
                .set({ status: "revoked", revokedAt: new Date(), currentVersionId: null })
                .where(eq(principalCredentials.id, input.id))
                .returning();
              return updated ?? null;
            }),
          ),
        ),

      markNeedsReauth: (input) =>
        withError(
          "markNeedsReauth",
          Effect.gen(function* () {
            const [updated] = yield* db
              .update(principalCredentials)
              .set({ status: "needs_reauth" })
              .where(
                and(
                  eq(principalCredentials.id, input.id),
                  eq(principalCredentials.ownerUserId, input.ownerUserId),
                ),
              )
              .returning();
            return updated ?? null;
          }),
        ),

      recordUsage: (id) =>
        withError(
          "recordUsage",
          Effect.gen(function* () {
            yield* db
              .update(principalCredentials)
              .set({ lastUsedAt: new Date() })
              .where(eq(principalCredentials.id, id));
          }),
        ),
    } satisfies PrincipalCredentialRepoService;
  }),
);
