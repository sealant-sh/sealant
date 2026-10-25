import { and, eq, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  placementAccountStatus,
  type HomeChange,
  type HomeState,
  type PlacementAccount,
} from "../credential-placements.js";
import {
  connectedAccountDefaults,
  connectedAccounts,
  workspaceCredentialHomes,
  workspaceCredentialPlacements as placements,
  workspaceRuntimeInstances,
  type WorkspaceCredentialHome,
  type WorkspaceCredentialPlacementLogin,
  type WorkspaceRuntimeInstance,
} from "../schema.js";

export class CredentialPlacementRepoError extends Schema.TaggedError<CredentialPlacementRepoError>()(
  "CredentialPlacementRepoError",
  { message: Schema.String },
) {}

export interface CredentialPlacementHome {
  readonly runId: string;
  readonly home: string;
}

export interface CredentialPlacementTarget {
  readonly home: WorkspaceCredentialHome;
  readonly instance: WorkspaceRuntimeInstance;
}

export interface CredentialPlacementRepoService {
  readonly state: (
    home: CredentialPlacementHome,
    accountIds?: readonly string[],
  ) => Effect.Effect<HomeState, CredentialPlacementRepoError>;
  readonly transact: <A>(
    home: CredentialPlacementHome,
    accountIds: readonly string[],
    decide: (state: HomeState) => HomeChange<A>,
  ) => Effect.Effect<
    { readonly result: A; readonly state: HomeState },
    CredentialPlacementRepoError
  >;
  readonly homesHoldingSubscription: (
    accountId: string,
  ) => Effect.Effect<readonly CredentialPlacementTarget[], CredentialPlacementRepoError>;
  readonly homesWithRemovalWork: () => Effect.Effect<
    readonly CredentialPlacementTarget[],
    CredentialPlacementRepoError
  >;
  readonly recordLegacyCodexKey: (input: {
    readonly accountId: string;
    readonly revision: number;
    readonly login: Extract<WorkspaceCredentialPlacementLogin, { readonly kind: "api-key" }>;
  }) => Effect.Effect<void, CredentialPlacementRepoError>;
}

export class CredentialPlacementRepo extends Context.Service<
  CredentialPlacementRepo,
  CredentialPlacementRepoService
>()("CredentialPlacementRepo") {}

const key = (home: CredentialPlacementHome) =>
  and(eq(placements.runId, home.runId), eq(placements.home, home.home));
const homeKey = (home: CredentialPlacementHome) =>
  and(eq(workspaceCredentialHomes.runId, home.runId), eq(workspaceCredentialHomes.home, home.home));
const orderedForReadySlotIndex = <Row extends { readonly state: string }>(
  rows: readonly Row[],
): readonly Row[] => [
  ...rows.filter((row) => row.state !== "ready"),
  ...rows.filter((row) => row.state === "ready"),
];
const safe = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.mapError(
      () =>
        new CredentialPlacementRepoError({ message: "Credential placement persistence failed." }),
    ),
  );

export const CredentialPlacementRepoLive = Layer.effect(
  CredentialPlacementRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const rowsOf = (home: CredentialPlacementHome) =>
      db.select().from(placements).where(key(home)).orderBy(placements.createdAt, placements.id);

    const homesWhere = (where: SQL | undefined) =>
      db
        .select({ home: workspaceCredentialHomes, instance: workspaceRuntimeInstances })
        .from(workspaceCredentialHomes)
        .innerJoin(
          workspaceRuntimeInstances,
          eq(workspaceRuntimeInstances.runId, workspaceCredentialHomes.runId),
        )
        .where(where);

    const load = (home: CredentialPlacementHome, accountIds: readonly string[], lock: boolean) =>
      Effect.gen(function* () {
        const ids = [
          ...new Set([...(yield* rowsOf(home)).map((row) => row.accountId), ...accountIds]),
        ].toSorted();
        const query = db
          .select()
          .from(connectedAccounts)
          .where(inArray(connectedAccounts.id, ids))
          .orderBy(connectedAccounts.id);
        const accounts = ids.length === 0 ? [] : yield* lock ? query.for("share") : query;
        const placementsOnceAccountsHeld = yield* rowsOf(home);
        const [held] = yield* db.select().from(workspaceCredentialHomes).where(homeKey(home));
        const defaults =
          held === undefined
            ? []
            : yield* db
                .select({ id: connectedAccountDefaults.connectedAccountId })
                .from(connectedAccountDefaults)
                .where(eq(connectedAccountDefaults.ownerUserId, held.onBehalfOfUserId));
        return {
          held,
          placements: placementsOnceAccountsHeld,
          accounts: new Map(
            accounts.map((account): [string, PlacementAccount] => [
              account.id,
              {
                id: account.id,
                name: account.name,
                ownerUserId: account.ownerUserId,
                provider: account.provider,
                revision: account.credentialRevision,
                status: placementAccountStatus(account),
              },
            ]),
          ),
          defaults: new Set(defaults.flatMap((row) => (row.id === null ? [] : [row.id]))),
        } satisfies HomeState;
      });

    return {
      state: (home, accountIds = []) => safe(load(home, accountIds, false)),
      transact: (home, accountIds, decide) =>
        safe(
          db.transaction(() =>
            Effect.gen(function* () {
              const before = yield* load(home, accountIds, true);
              const change = decide(before);
              if (change.insertHome !== undefined && before.held === undefined) {
                yield* db
                  .insert(workspaceCredentialHomes)
                  .values({ ...home, ...change.insertHome });
              }
              if (change.releasing === true) {
                yield* db
                  .update(workspaceCredentialHomes)
                  .set({ releasing: true })
                  .where(homeKey(home));
              }
              const previous = new Map(before.placements.map((row) => [row.id, row]));
              const kept = change.placements.map((row) => row.id);
              if (before.placements.some((row) => !kept.includes(row.id))) {
                yield* db
                  .delete(placements)
                  .where(
                    kept.length === 0 ? key(home) : and(key(home), notInArray(placements.id, kept)),
                  );
              }
              const changed = change.placements.filter((row) => {
                const was = previous.get(row.id);
                return (
                  was !== undefined && (was.state !== row.state || was.revision !== row.revision)
                );
              });
              for (const row of orderedForReadySlotIndex(changed)) {
                yield* db
                  .update(placements)
                  .set({ state: row.state, revision: row.revision })
                  .where(eq(placements.id, row.id));
              }
              const inserted = change.placements.filter((row) => !previous.has(row.id));
              if (inserted.length > 0) yield* db.insert(placements).values(inserted);
              const [held] = yield* db.select().from(workspaceCredentialHomes).where(homeKey(home));
              return {
                result: change.result,
                state: { ...before, held, placements: change.placements },
              };
            }),
          ),
        ),
      homesHoldingSubscription: (accountId) =>
        safe(
          homesWhere(
            and(
              eq(workspaceRuntimeInstances.status, "ready"),
              sql`exists (select 1 from ${placements} where ${placements.runId} = ${workspaceCredentialHomes.runId} and ${placements.home} = ${workspaceCredentialHomes.home} and ${placements.accountId} = ${accountId} and ${placements.state} in ('pending', 'ready') and ${placements.login}->>'kind' = 'subscription')`,
            ),
          ),
        ),
      homesWithRemovalWork: () =>
        safe(
          homesWhere(
            and(
              notInArray(workspaceRuntimeInstances.status, ["pending", "running"]),
              or(
                workspaceCredentialHomes.releasing,
                sql`exists (select 1 from ${placements} where ${placements.runId} = ${workspaceCredentialHomes.runId} and ${placements.home} = ${workspaceCredentialHomes.home} and ${placements.state} in ('pending', 'removing'))`,
              ),
            ),
          ),
        ),
      recordLegacyCodexKey: ({ accountId, revision, login }) =>
        safe(
          db
            .update(placements)
            .set({ login })
            .where(
              and(
                eq(placements.accountId, accountId),
                eq(placements.revision, revision),
                eq(placements.provider, "codex"),
                sql`${placements.login}->>'kind' = 'subscription'`,
              ),
            ),
        ),
    } satisfies CredentialPlacementRepoService;
  }),
);
