import { and, desc, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAccounts, boatKeyProofs } from "../schema/boat-accounts.js";
import { createWalletOf, installCreateWallet } from "./boat-wallets.js";

/** Safe failure codes: never a key or a provider body. */
export class BoatKeyProofStoreError extends Error {
  readonly _tag = "BoatKeyProofStoreError";
  constructor(readonly code: "unavailable") {
    super(`Boat key proof store: ${code}`);
  }
}

type Failing<A> = Effect.Effect<A, BoatKeyProofStoreError>;

/** One full check as its ledger holds it. */
export interface BoatKeyProofRecord {
  readonly id: string;
  /** A stored account's id, or `default`. */
  readonly account: string;
  readonly createKey: string;
  readonly snapshotName: string;
  readonly startedAt: Date;
  readonly claimedUntil: Date;
  readonly createIssuedAt: Date | null;
  readonly sandboxId: string | null;
  readonly saveIssuedAt: Date | null;
  readonly vmDeletedAt: Date | null;
  readonly snapshotDeletedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly cleanupPending: boolean;
  readonly result: unknown;
  /**
   * The wallet the check made its VM and snapshot in (null: the key's only one), named on every
   * request about them; undefined while sealant does not know it (a check made before wallets were
   * recorded, by an account with no pin), or Boat has them in no wallet the key can bill.
   */
  readonly wallet: string | null | undefined;
}

/**
 * The ledger of full checks of Boat keys. Every write that precedes a Boat call that may create
 * something (`createIssued`, `saveIssued`) commits before the call is sent, so the sweep always
 * knows what to look for.
 */
export interface BoatKeyProofRepoService {
  /** Starts a check, unless one of the same account is unfinished: then `running`. */
  readonly start: (input: {
    readonly id: string;
    readonly account: string;
    readonly createKey: string;
    readonly snapshotName: string;
    readonly startedAt: Date;
    readonly claimedUntil: Date;
    /** The wallet the check's client names (null: none). Recorded with the check. */
    readonly wallet: string | null;
  }) => Failing<"started" | "running" | "wallet-changed">;
  readonly createIssued: (id: string, at: Date) => Failing<void>;
  readonly sandboxSeen: (id: string, sandboxId: string) => Failing<void>;
  readonly saveIssued: (id: string, at: Date) => Failing<void>;
  readonly vmDeleted: (id: string, at: Date) => Failing<void>;
  readonly snapshotDeleted: (id: string, at: Date) => Failing<void>;
  /** The check's end: its result, and whether Boat may still hold what it made. */
  readonly finish: (
    id: string,
    input: { readonly at: Date; readonly result: unknown; readonly cleanupPending: boolean },
  ) => Failing<void>;
  /**
   * The checks the sweep takes over: unfinished ones whose claim has passed (their process
   * stopped), and finished ones whose cleanup is pending.
   */
  readonly toSweep: (now: Date) => Failing<readonly BoatKeyProofRecord[]>;
  /** The sweep's end for a check: nothing of it is left in Boat. Finishes it if it was not. */
  readonly settle: (
    id: string,
    input: { readonly at: Date; readonly result: unknown },
  ) => Failing<void>;
  /** Each account's last finished check, by account. */
  readonly latest: () => Failing<ReadonlyMap<string, BoatKeyProofRecord>>;
  readonly get: (id: string) => Failing<BoatKeyProofRecord | undefined>;
  /**
   * The account's checks Boat may still hold something of: unfinished, or finished with their
   * cleanup pending. While there is one, the account keeps its key: no removal, no rotation.
   */
  readonly outstanding: (account: string) => Failing<readonly BoatKeyProofRecord[]>;
}

export class BoatKeyProofRepo extends Context.Service<BoatKeyProofRepo, BoatKeyProofRepoService>()(
  "@sealant/db/BoatKeyProofRepo",
) {}

type ProofRow = typeof boatKeyProofs.$inferSelect;
const toRecord = ({ boatWallet, boatWalletState, ...row }: ProofRow): BoatKeyProofRecord => ({
  ...row,
  wallet: boatWalletState === "known" ? boatWallet : undefined,
});

const make: Effect.Effect<BoatKeyProofRepoService, never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const boundary = <A>(effect: Effect.Effect<A, unknown>): Failing<A> =>
    effect.pipe(Effect.mapError(() => new BoatKeyProofStoreError("unavailable")));
  const set = (id: string, values: Partial<typeof boatKeyProofs.$inferInsert>) =>
    boundary(
      db.update(boatKeyProofs).set(values).where(eq(boatKeyProofs.id, id)).pipe(Effect.asVoid),
    );
  return BoatKeyProofRepo.of({
    // Recorded in the wallet the account creates in now, read under the row its wallet change
    // takes `for update`; a client that names another (the wallet changed since it was opened)
    // starts nothing. A change is refused while the check is outstanding.
    start: ({ wallet, ...input }) =>
      boundary(
        db.transaction(() =>
          Effect.gen(function* () {
            const current =
              input.account === "default"
                ? yield* installCreateWallet(db)
                : yield* db
                    .select({
                      organization: boatAccounts.boatOrganization,
                      keyKind: boatAccounts.keyKind,
                    })
                    .from(boatAccounts)
                    .where(eq(boatAccounts.id, input.account))
                    .for("share")
                    .pipe(
                      // No such account (a test's): nothing to name, as for an install with none.
                      Effect.map(([row]) =>
                        row === undefined
                          ? ({ kind: "known", wallet: null } as const)
                          : createWalletOf(row.organization, row.keyKind),
                      ),
                    );
            if (current.kind !== "known" || current.wallet !== wallet)
              return "wallet-changed" as const;
            const rows = yield* db
              .insert(boatKeyProofs)
              .values({ ...input, boatWallet: wallet, boatWalletState: "known" })
              .onConflictDoNothing()
              .returning({ id: boatKeyProofs.id });
            return rows.length === 0 ? ("running" as const) : ("started" as const);
          }),
        ),
      ),
    createIssued: (id, at) => set(id, { createIssuedAt: at }),
    sandboxSeen: (id, sandboxId) => set(id, { sandboxId }),
    saveIssued: (id, at) => set(id, { saveIssuedAt: at }),
    vmDeleted: (id, at) => set(id, { vmDeletedAt: at }),
    snapshotDeleted: (id, at) => set(id, { snapshotDeletedAt: at }),
    // Only a check still unfinished: one the sweep already settled keeps the sweep's result.
    finish: (id, input) =>
      boundary(
        db
          .update(boatKeyProofs)
          .set({ finishedAt: input.at, result: input.result, cleanupPending: input.cleanupPending })
          .where(and(eq(boatKeyProofs.id, id), isNull(boatKeyProofs.finishedAt)))
          .pipe(Effect.asVoid),
      ),
    toSweep: (now) =>
      boundary(
        db
          .select()
          .from(boatKeyProofs)
          .where(
            and(
              or(
                and(isNull(boatKeyProofs.finishedAt), lt(boatKeyProofs.claimedUntil, now)),
                eq(boatKeyProofs.cleanupPending, true),
              ),
              // Boat has what it made in none of the key's wallets: nothing is left to delete.
              ne(boatKeyProofs.boatWalletState, "unreachable"),
            ),
          )
          .orderBy(boatKeyProofs.startedAt)
          .limit(20)
          .pipe(Effect.map((rows) => rows.map(toRecord))),
      ),
    settle: (id, input) =>
      boundary(
        db
          .update(boatKeyProofs)
          .set({
            cleanupPending: false,
            finishedAt: sql`coalesce(${boatKeyProofs.finishedAt}, ${input.at.toISOString()}::timestamptz)`,
            result: sql`coalesce(${boatKeyProofs.result}, ${JSON.stringify(input.result)}::jsonb)`,
          })
          .where(eq(boatKeyProofs.id, id))
          .pipe(Effect.asVoid),
      ),
    latest: () =>
      boundary(
        db
          .selectDistinctOn([boatKeyProofs.account])
          .from(boatKeyProofs)
          .where(and(isNotNull(boatKeyProofs.finishedAt), isNotNull(boatKeyProofs.result)))
          .orderBy(boatKeyProofs.account, desc(boatKeyProofs.finishedAt))
          .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.account, toRecord(row)])))),
      ),
    outstanding: (account) =>
      boundary(
        db
          .select()
          .from(boatKeyProofs)
          .where(
            and(
              eq(boatKeyProofs.account, account),
              or(isNull(boatKeyProofs.finishedAt), eq(boatKeyProofs.cleanupPending, true)),
              // Boat has what it made in no wallet the key can bill: finished, as the sweep reads it.
              ne(boatKeyProofs.boatWalletState, "unreachable"),
            ),
          )
          .orderBy(boatKeyProofs.startedAt)
          .pipe(Effect.map((rows) => rows.map(toRecord))),
      ),
    get: (id) =>
      boundary(
        db
          .select()
          .from(boatKeyProofs)
          .where(eq(boatKeyProofs.id, id))
          .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toRecord(rows[0])))),
      ),
  });
});

export const BoatKeyProofRepoLive: Layer.Layer<BoatKeyProofRepo, never, SealantDB> = Layer.effect(
  BoatKeyProofRepo,
  make,
);
