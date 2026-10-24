import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlError } from "effect/sql/SqlError";

import { SealantDB } from "../client.js";
import {
  connectedAccountDefaults,
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
  "listByOwnerProvider",
  "listActiveByProviderKind",
  "withOwnerLock",
  "getDefault",
  "setDefault",
  "backfillDefaults",
  "replacePayload",
  "updateSyncState",
  "markInvalid",
  "claimRefresh",
  "releaseRefresh",
  "archiveAndClearDefault",
  "restore",
  "setProfileBinding",
  "clearProfileBinding",
  "listProfileBindings",
  "listBindingsForAccount",
  "getBindingsForProfileWithAccounts",
]);

export class ConnectedAccountRepoInvariantError extends Schema.TaggedError<ConnectedAccountRepoInvariantError>()(
  "ConnectedAccountRepoInvariantError",
  {
    operation: connectedAccountRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class ConnectedAccountRepoUnexpectedError extends Schema.TaggedError<ConnectedAccountRepoUnexpectedError>()(
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

export type ConnectedAccountWithDefault = ConnectedAccount & {
  readonly isDefault: boolean;
};

const withDefaultFlag = (row: {
  readonly account: ConnectedAccount;
  readonly defaultAccountId: string | null;
}): ConnectedAccountWithDefault => ({
  ...row.account,
  isDefault: row.defaultAccountId !== null,
});

/** The credential revision once `payloadSha256` is stored: the same bytes keep it, new bytes move it on. */
const revisionAfterStoring = (payloadSha256: string) =>
  sql`case when ${connectedAccounts.payloadSha256} = ${payloadSha256} then ${connectedAccounts.credentialRevision} else ${connectedAccounts.credentialRevision} + 1 end`;

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
  /** "oauth-token" | "credentials-json" (claude) | "auth-json" (codex) | "gh-cli-token" (github). */
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
  /**
   * New payload kind when the replacement switched shapes (e.g. a claude reconnect pasting a
   * session credentials file over a setup-token row). Omitted -> the stored kind is kept.
   */
  readonly kind?: string;
  readonly encryptedPayload: string;
  readonly encryptionKeyId: string;
  readonly payloadSha256: string;
  readonly metadata: Record<string, unknown>;
  readonly expectedRevision?: number;
}

export interface ConnectedAccountDefaultInput {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
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
  readonly account: ConnectedAccountWithDefault;
}

export interface ConnectedAccountRepoService {
  readonly createConnectedAccount: (
    input: CreateConnectedAccountInput,
  ) => Effect.Effect<ConnectedAccount, ConnectedAccountRepoError>;
  readonly getById: (
    id: string,
  ) => Effect.Effect<ConnectedAccountWithDefault | undefined, ConnectedAccountRepoError>;
  /** The single active (non-archived) account for an (owner, provider, name) triple. */
  readonly getByOwnerProviderName: (
    input: GetConnectedAccountByOwnerProviderNameInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /** Non-archived accounts for one owner, newest first. */
  readonly listByOwner: (
    ownerUserId: string,
  ) => Effect.Effect<readonly ConnectedAccountWithDefault[], ConnectedAccountRepoError>;
  readonly listByOwnerProvider: (
    input: ConnectedAccountDefaultInput,
  ) => Effect.Effect<readonly ConnectedAccountWithDefault[], ConnectedAccountRepoError>;
  /** Run `use` in one transaction that holds this owner's lock, so their account writes take turns. */
  readonly withOwnerLock: <A, E, R>(
    ownerUserId: string,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ConnectedAccountRepoError, R>;
  readonly getDefault: (
    input: ConnectedAccountDefaultInput,
  ) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  readonly setDefault: (
    input: ConnectedAccountDefaultInput & {
      readonly connectedAccountId: string;
    },
  ) => Effect.Effect<void, ConnectedAccountRepoError>;
  readonly backfillDefaults: Effect.Effect<number, ConnectedAccountRepoError>;
  /**
   * ACTIVE (non-archived, non-invalid) accounts across all owners for one (provider, kind) pair —
   * the keep-fresh sweeper's candidate set. `kind` is a cheap prefilter only; consumers still
   * dispatch on the decrypted payload SHAPE before acting.
   */
  readonly listActiveByProviderKind: (input: {
    readonly provider: ConnectedAccountProvider;
    readonly kind: string;
  }) => Effect.Effect<readonly ConnectedAccount[], ConnectedAccountRepoError>;
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
    readonly revision?: number;
  }) => Effect.Effect<ConnectedAccount | undefined, ConnectedAccountRepoError>;
  /**
   * One refresh per login at a time, across every worker (docs/connected-accounts-design.md §6a).
   * True when this caller now holds the claim until `until`: no claim was held, or the one held has
   * lapsed. A crashed pass's claim lapses on its own.
   */
  readonly claimRefresh: (input: {
    readonly id: string;
    readonly until: Date;
    readonly now: Date;
  }) => Effect.Effect<boolean, ConnectedAccountRepoError>;
  /** Give the claim back once the refresh (and its push) ended, whichever way. */
  readonly releaseRefresh: (input: {
    readonly id: string;
  }) => Effect.Effect<void, ConnectedAccountRepoError>;
  readonly archiveAndClearDefault: (
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

    const accountsWithDefault = () =>
      db
        .select({
          account: connectedAccounts,
          defaultAccountId: connectedAccountDefaults.connectedAccountId,
        })
        .from(connectedAccounts)
        .leftJoin(
          connectedAccountDefaults,
          eq(connectedAccountDefaults.connectedAccountId, connectedAccounts.id),
        );

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
            const [row] = yield* accountsWithDefault().where(eq(connectedAccounts.id, id)).limit(1);

            return row === undefined ? undefined : withDefaultFlag(row);
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
          accountsWithDefault()
            .where(
              and(
                eq(connectedAccounts.ownerUserId, ownerUserId),
                isNull(connectedAccounts.archivedAt),
              ),
            )
            .orderBy(desc(connectedAccounts.createdAt))
            .pipe(Effect.map((rows) => rows.map(withDefaultFlag))),
        ),

      listByOwnerProvider: (input) =>
        withConnectedAccountRepoError(
          "listByOwnerProvider",
          accountsWithDefault()
            .where(
              and(
                eq(connectedAccounts.ownerUserId, input.ownerUserId),
                eq(connectedAccounts.provider, input.provider),
                isNull(connectedAccounts.archivedAt),
              ),
            )
            .orderBy(desc(connectedAccounts.createdAt))
            .pipe(Effect.map((rows) => rows.map(withDefaultFlag))),
        ),

      withOwnerLock: (ownerUserId, use) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              yield* withConnectedAccountRepoError(
                "withOwnerLock",
                db.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${`connected-accounts ${ownerUserId}`}, 0))`,
                ),
              );
              return yield* use;
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof SqlError
                ? mapConnectedAccountRepoError("withOwnerLock", error)
                : error,
            ),
          ),

      getDefault: (input) =>
        withConnectedAccountRepoError(
          "getDefault",
          Effect.gen(function* () {
            const [row] = yield* db
              .select({ account: connectedAccounts })
              .from(connectedAccountDefaults)
              .innerJoin(
                connectedAccounts,
                eq(connectedAccountDefaults.connectedAccountId, connectedAccounts.id),
              )
              .where(
                and(
                  eq(connectedAccountDefaults.ownerUserId, input.ownerUserId),
                  eq(connectedAccountDefaults.provider, input.provider),
                ),
              )
              .limit(1);

            return row?.account;
          }),
        ),

      setDefault: (input) =>
        withConnectedAccountRepoError(
          "setDefault",
          db
            .insert(connectedAccountDefaults)
            .values({
              ownerUserId: input.ownerUserId,
              provider: input.provider,
              connectedAccountId: input.connectedAccountId,
            })
            .onConflictDoUpdate({
              target: [connectedAccountDefaults.ownerUserId, connectedAccountDefaults.provider],
              set: {
                connectedAccountId: input.connectedAccountId,
                updatedAt: new Date(),
              },
              setWhere: sql`${connectedAccountDefaults.connectedAccountId} is distinct from ${input.connectedAccountId}`,
            })
            .pipe(Effect.asVoid),
        ),

      backfillDefaults: withConnectedAccountRepoError(
        "backfillDefaults",
        db
          .execute<{ readonly owner_user_id: string }>(
            sql`insert into ${connectedAccountDefaults} (owner_user_id, provider, connected_account_id, updated_at)
              select owner_user_id, provider, id, now() from ${connectedAccounts}
              where name = 'default' and archived_at is null
              on conflict (owner_user_id, provider) do update
                set connected_account_id = excluded.connected_account_id, updated_at = now()
                where ${connectedAccountDefaults}.connected_account_id in (
                  select id from ${connectedAccounts} where archived_at is not null
                )
              returning owner_user_id`,
            "objects",
          )
          .pipe(Effect.map((rows) => rows.length)),
      ),

      listActiveByProviderKind: (input) =>
        withConnectedAccountRepoError(
          "listActiveByProviderKind",
          db
            .select()
            .from(connectedAccounts)
            .where(
              and(
                eq(connectedAccounts.provider, input.provider),
                eq(connectedAccounts.kind, input.kind),
                eq(connectedAccounts.status, "active"),
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
                ...(input.kind === undefined ? {} : { kind: input.kind }),
                encryptedPayload: input.encryptedPayload,
                encryptionKeyId: input.encryptionKeyId,
                payloadSha256: input.payloadSha256,
                credentialRevision: revisionAfterStoring(input.payloadSha256),
                metadata: input.metadata,
                status: "active",
                invalidAt: null,
              })
              .where(
                and(
                  eq(connectedAccounts.id, input.id),
                  input.expectedRevision === undefined
                    ? undefined
                    : eq(connectedAccounts.credentialRevision, input.expectedRevision),
                ),
              )
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
              .where(
                and(
                  eq(connectedAccounts.id, input.id),
                  isNull(connectedAccounts.archivedAt),
                  input.revision === undefined
                    ? undefined
                    : eq(connectedAccounts.credentialRevision, input.revision),
                ),
              )
              .returning();

            return connectedAccount;
          }),
        ),

      claimRefresh: (input) =>
        withConnectedAccountRepoError(
          "claimRefresh",
          Effect.gen(function* () {
            const claimed = yield* db
              .update(connectedAccounts)
              .set({ refreshClaimedUntil: input.until })
              .where(
                and(
                  eq(connectedAccounts.id, input.id),
                  isNull(connectedAccounts.archivedAt),
                  or(
                    isNull(connectedAccounts.refreshClaimedUntil),
                    lt(connectedAccounts.refreshClaimedUntil, input.now),
                  ),
                ),
              )
              .returning({ id: connectedAccounts.id });

            return claimed.length === 1;
          }),
        ),

      releaseRefresh: (input) =>
        withConnectedAccountRepoError(
          "releaseRefresh",
          db
            .update(connectedAccounts)
            .set({ refreshClaimedUntil: null })
            .where(eq(connectedAccounts.id, input.id))
            .pipe(Effect.asVoid),
        ),

      archiveAndClearDefault: (input) =>
        withConnectedAccountRepoError(
          "archiveAndClearDefault",
          db.transaction(() =>
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

              if (connectedAccount !== undefined) {
                yield* db
                  .update(connectedAccountDefaults)
                  .set({ connectedAccountId: null, updatedAt: new Date() })
                  .where(
                    and(
                      eq(connectedAccountDefaults.ownerUserId, connectedAccount.ownerUserId),
                      eq(connectedAccountDefaults.provider, connectedAccount.provider),
                      eq(connectedAccountDefaults.connectedAccountId, connectedAccount.id),
                    ),
                  );
              }

              return connectedAccount;
            }),
          ),
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
                set: {
                  connectedAccountId: input.connectedAccountId,
                  updatedAt: new Date(),
                },
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
            .select({
              binding: profileConnectedAccounts,
              account: connectedAccounts,
              defaultAccountId: connectedAccountDefaults.connectedAccountId,
            })
            .from(profileConnectedAccounts)
            .innerJoin(
              connectedAccounts,
              eq(profileConnectedAccounts.connectedAccountId, connectedAccounts.id),
            )
            .leftJoin(
              connectedAccountDefaults,
              eq(connectedAccountDefaults.connectedAccountId, connectedAccounts.id),
            )
            .where(eq(profileConnectedAccounts.profileId, profileId))
            .pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  binding: row.binding,
                  account: withDefaultFlag(row),
                })),
              ),
            ),
        ),
    } satisfies ConnectedAccountRepoService;
  }),
);
