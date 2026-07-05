import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  connectedAccounts,
  profileConnectedAccounts,
  type ConnectedAccount,
  type ConnectedAccountProvider,
  type NewConnectedAccount,
  type NewProfileConnectedAccount,
  type ProfileConnectedAccount,
} from "../schema.js";

/*
Connected provider accounts (Claude / Codex / GitHub credentials) and their profile bindings.
Rows store only sealed payloads (see @sealant/credentials); this repo never sees plaintext.
Deletion is a soft archive: profile_connected_accounts references connected_accounts.id without
cascade (archive handling is app-level), and the partial unique index frees (owner, provider,
name) for reconnects.
*/

const connectedAccountRepoOperationSchema = Schema.Literals([
  "createConnectedAccount",
  "getById",
  "getByOwnerProviderName",
  "listByOwner",
  "replacePayload",
  "updateSyncState",
  "markInvalid",
  "archive",
  "restore",
  "setProfileBinding",
  "clearProfileBinding",
  "listProfileBindings",
  "listBindingsForAccount",
  "getBindingsForProfileWithAccounts",
]);

export class ConnectedAccountRepoInvariantError extends Schema.TaggedErrorClass<ConnectedAccountRepoInvariantError>()(
  "ConnectedAccountRepoInvariantError",
  {
    operation: connectedAccountRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class ConnectedAccountRepoUnexpectedError extends Schema.TaggedErrorClass<ConnectedAccountRepoUnexpectedError>()(
  "ConnectedAccountRepoUnexpectedError",
  {
    operation: connectedAccountRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const connectedAccountRepoErrorSchema = Schema.Union([
  ConnectedAccountRepoInvariantError,
  ConnectedAccountRepoUnexpectedError,
]);

export type ConnectedAccountRepoError = typeof connectedAccountRepoErrorSchema.Type;

type ConnectedAccountRepoOperation = typeof connectedAccountRepoOperationSchema.Type;

const mapConnectedAccountRepoError = (
  operation: ConnectedAccountRepoOperation,
  cause: unknown,
): ConnectedAccountRepoError => {
  if (
    cause instanceof ConnectedAccountRepoInvariantError ||
    cause instanceof ConnectedAccountRepoUnexpectedError
  ) {
    return cause;
  }

  return new ConnectedAccountRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withConnectedAccountRepoError = <A>(
  operation: ConnectedAccountRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ConnectedAccountRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapConnectedAccountRepoError(operation, cause)));
};

export interface CreateConnectedAccountInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
  readonly name: string;
  /** "oauth-token" (claude) | "auth-json" (codex) | "gh-cli-token" (github). */
  readonly kind: string;
  readonly encryptedPayload: string;
  readonly encryptionKeyId: string;
  readonly payloadSha256: string;
  readonly metadata: Record<string, unknown>;
}

export interface GetConnectedAccountByOwnerProviderNameInput {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
  readonly name: string;
}

export interface ReplaceConnectedAccountPayloadInput {
  readonly id: string;
  readonly encryptedPayload: string;
  readonly encryptionKeyId: string;
  readonly payloadSha256: string;
  readonly metadata: Record<string, unknown>;
}

export interface UpdateConnectedAccountSyncStateInput {
  readonly id: string;
  readonly metadata?: Record<string, unknown>;
  readonly lastSyncedAt?: Date;
  readonly lastUsedAt?: Date;
}

export interface ArchiveConnectedAccountInput {
  readonly id: string;
  readonly ownerUserId: string;
}

export interface RestoreConnectedAccountInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name?: string;
}

export interface SetProfileConnectedAccountBindingInput {
  readonly profileId: string;
  readonly provider: ConnectedAccountProvider;
  readonly connectedAccountId: string;
}

export interface ClearProfileConnectedAccountBindingInput {
  readonly profileId: string;
  readonly provider: ConnectedAccountProvider;
}

export interface ProfileConnectedAccountBindingWithAccount {
  readonly binding: ProfileConnectedAccount;
  readonly account: ConnectedAccount;
}

export interface ConnectedAccountRepoService {
  readonly createConnectedAccount: (
    input: CreateConnectedAccountInput,
  ) => Effect.Effect<ConnectedAccount, ConnectedAccountRepoError>;
  readonly getById: (
    id: string,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** The single active (non-archived) account for an (owner, provider, name) triple. */
  readonly getByOwnerProviderName: (
    input: GetConnectedAccountByOwnerProviderNameInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Non-archived accounts for one owner, newest first. */
  readonly listByOwner: (
    ownerUserId: string,
  ) => Effect.Effect<readonly ConnectedAccount[], ConnectedAccountRepoError>;
  /** Reconnect: swap the sealed payload, reset status to "active", clear invalid_at. */
  readonly replacePayload: (
    input: ReplaceConnectedAccountPayloadInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Bookkeeping after launches/sync-backs (last_used_at, last_synced_at, metadata refresh). */
  readonly updateSyncState: (
    input: UpdateConnectedAccountSyncStateInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** 401 feedback: mark the credential invalid so surfaces prompt a re-auth. */
  readonly markInvalid: (input: {
    readonly id: string;
  }) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Soft delete; returns undefined when no active account matched (wrong id or wrong owner). */
  readonly archive: (
    input: ArchiveConnectedAccountInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Un-archive (same owner reconnecting the same account row). */
  readonly restore: (
    input: RestoreConnectedAccountInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Upsert on the (profile_id, provider) pk — one account per provider per profile. */
  readonly setProfileBinding: (
    input: SetProfileConnectedAccountBindingInput,
  ) => Effect.Effect<ProfileConnectedAccount, ConnectedAccountRepoError>;
  /** Returns the removed binding, or undefined when none existed. */
  readonly clearProfileBinding: (
    input: ClearProfileConnectedAccountBindingInput,
  ) => Effect.Effect<ProfileConnectedAccount | undefined, ConnectedAccountRepoError>;
  readonly listProfileBindings: (
    profileId: string,
  ) => Effect.Effect<readonly ProfileConnectedAccount[], ConnectedAccountRepoError>;
  readonly listBindingsForAccount: (
    connectedAccountId: string,
  ) => Effect.Effect<readonly ProfileConnectedAccount[], ConnectedAccountRepoError>;
  readonly getBindingsForProfileWithAccounts: (
    profileId: string,
  ) => Effect.Effect<
    readonly ProfileConnectedAccountBindingWithAccount[],
    ConnectedAccountRepoError
  >;
}

export class ConnectedAccountRepo extends Context.Service<
  ConnectedAccountRepo,
  ConnectedAccountRepoService
>()("ConnectedAccountRepo") {}

export const ConnectedAccountRepoLive = Layer.effect(
  ConnectedAccountRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createConnectedAccount: (input) =>
        withConnectedAccountRepoError(
          "createConnectedAccount",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .insert(connectedAccounts)
              .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                provider: input.provider,
                name: input.name,
                kind: input.kind,
                encryptedPayload: input.encryptedPayload,
                encryptionKeyId: input.encryptionKeyId,
                payloadSha256: input.payloadSha256,
                metadata: input.metadata,
              } satisfies NewConnectedAccount)
              .returning();

            if (connectedAccount === undefined) {
              return yield* new ConnectedAccountRepoInvariantError({
                operation: "createConnectedAccount",
                message: `Failed to create connected account for owner ${input.ownerUserId}.`,
              });
            }

            return connectedAccount;
          }),
        ),

      getById: (id) =>
        withConnectedAccountRepoError(
          "getById",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .select()
              .from(connectedAccounts)
              .where(eq(connectedAccounts.id, id))
              .limit(1);

            return connectedAccount;
          }),
        ),

      getByOwnerProviderName: (input) =>
        withConnectedAccountRepoError(
          "getByOwnerProviderName",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .select()
              .from(connectedAccounts)
              .where(
                and(
                  eq(connectedAccounts.ownerUserId, input.ownerUserId),
                  eq(connectedAccounts.provider, input.provider),
                  eq(connectedAccounts.name, input.name),
                  isNull(connectedAccounts.archivedAt),
                ),
              )
              .limit(1);

            return connectedAccount;
          }),
        ),

      listByOwner: (ownerUserId) =>
        withConnectedAccountRepoError(
          "listByOwner",
          db
            .select()
            .from(connectedAccounts)
            .where(
              and(
                eq(connectedAccounts.ownerUserId, ownerUserId),
                isNull(connectedAccounts.archivedAt),
              ),
            )
            .orderBy(desc(connectedAccounts.createdAt)),
        ),

      replacePayload: (input) =>
        withConnectedAccountRepoError(
          "replacePayload",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .update(connectedAccounts)
              .set({
                encryptedPayload: input.encryptedPayload,
                encryptionKeyId: input.encryptionKeyId,
                payloadSha256: input.payloadSha256,
                metadata: input.metadata,
                status: "active",
                invalidAt: null,
              })
              .where(eq(connectedAccounts.id, input.id))
              .returning();

            return connectedAccount;
          }),
        ),

      updateSyncState: (input) =>
        withConnectedAccountRepoError(
          "updateSyncState",
          Effect.gen(function* () {
            const set: Partial<NewConnectedAccount> = {
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
              ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
            };

            if (Object.keys(set).length === 0) {
              const [connectedAccount] = yield* db
                .select()
                .from(connectedAccounts)
                .where(eq(connectedAccounts.id, input.id))
                .limit(1);

              return connectedAccount;
            }

            const [connectedAccount] = yield* db
              .update(connectedAccounts)
              .set(set)
              .where(eq(connectedAccounts.id, input.id))
              .returning();

            return connectedAccount;
          }),
        ),

      markInvalid: (input) =>
        withConnectedAccountRepoError(
          "markInvalid",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .update(connectedAccounts)
              .set({ status: "invalid", invalidAt: new Date() })
              .where(and(eq(connectedAccounts.id, input.id), isNull(connectedAccounts.archivedAt)))
              .returning();

            return connectedAccount;
          }),
        ),

      archive: (input) =>
        withConnectedAccountRepoError(
          "archive",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .update(connectedAccounts)
              .set({ status: "archived", archivedAt: new Date() })
              .where(
                and(
                  eq(connectedAccounts.id, input.id),
                  eq(connectedAccounts.ownerUserId, input.ownerUserId),
                  isNull(connectedAccounts.archivedAt),
                ),
              )
              .returning();

            return connectedAccount;
          }),
        ),

      restore: (input) =>
        withConnectedAccountRepoError(
          "restore",
          Effect.gen(function* () {
            const [connectedAccount] = yield* db
              .update(connectedAccounts)
              .set({
                status: "active",
                archivedAt: null,
                invalidAt: null,
                ...(input.name === undefined ? {} : { name: input.name }),
              })
              .where(
                and(
                  eq(connectedAccounts.id, input.id),
                  eq(connectedAccounts.ownerUserId, input.ownerUserId),
                ),
              )
              .returning();

            return connectedAccount;
          }),
        ),

      setProfileBinding: (input) =>
        withConnectedAccountRepoError(
          "setProfileBinding",
          Effect.gen(function* () {
            const [binding] = yield* db
              .insert(profileConnectedAccounts)
              .values({
                profileId: input.profileId,
                provider: input.provider,
                connectedAccountId: input.connectedAccountId,
              } satisfies NewProfileConnectedAccount)
              .onConflictDoUpdate({
                target: [profileConnectedAccounts.profileId, profileConnectedAccounts.provider],
                set: { connectedAccountId: input.connectedAccountId, updatedAt: new Date() },
              })
              .returning();

            if (binding === undefined) {
              return yield* new ConnectedAccountRepoInvariantError({
                operation: "setProfileBinding",
                message: `Failed to bind connected account ${input.connectedAccountId} to profile ${input.profileId}.`,
              });
            }

            return binding;
          }),
        ),

      clearProfileBinding: (input) =>
        withConnectedAccountRepoError(
          "clearProfileBinding",
          Effect.gen(function* () {
            const [binding] = yield* db
              .delete(profileConnectedAccounts)
              .where(
                and(
                  eq(profileConnectedAccounts.profileId, input.profileId),
                  eq(profileConnectedAccounts.provider, input.provider),
                ),
              )
              .returning();

            return binding;
          }),
        ),

      listProfileBindings: (profileId) =>
        withConnectedAccountRepoError(
          "listProfileBindings",
          db
            .select()
            .from(profileConnectedAccounts)
            .where(eq(profileConnectedAccounts.profileId, profileId)),
        ),

      listBindingsForAccount: (connectedAccountId) =>
        withConnectedAccountRepoError(
          "listBindingsForAccount",
          db
            .select()
            .from(profileConnectedAccounts)
            .where(eq(profileConnectedAccounts.connectedAccountId, connectedAccountId)),
        ),

      getBindingsForProfileWithAccounts: (profileId) =>
        withConnectedAccountRepoError(
          "getBindingsForProfileWithAccounts",
          db
            .select({ binding: profileConnectedAccounts, account: connectedAccounts })
            .from(profileConnectedAccounts)
            .innerJoin(
              connectedAccounts,
              eq(profileConnectedAccounts.connectedAccountId, connectedAccounts.id),
            )
            .where(eq(profileConnectedAccounts.profileId, profileId)),
        ),
    } satisfies ConnectedAccountRepoService;
  }),
);
