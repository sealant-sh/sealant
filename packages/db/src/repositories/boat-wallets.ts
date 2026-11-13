/**
 * Which Boat wallet an account creates things in now, as the rows that record them read it.
 *
 * A personal Boat key sees an object, or not, depending on the wallet a request names, so every
 * object Core creates in Boat records the wallet it was created in (`boat_wallet`,
 * `boat_wallet_state` on runs, images and full checks), and every later request about it names
 * that wallet. The wallet a new object is created in is the account's pin
 * (`boat_accounts.boat_organization`), or, for an organization's key, the key's only wallet (null,
 * no header). An account with a personal or unobserved key and no pin was connected before Core
 * pinned accounts: it creates nothing until the worker has resolved it. The install's own key reads
 * the same from `boat_install`.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { boatAccounts, boatInstall } from "../schema/boat-accounts.js";

/** The wallet things are created in now: named (or null: the key's only one), or not resolved. */
export type BoatCreateWallet =
  | { readonly kind: "known"; readonly wallet: string | null }
  | { readonly kind: "unresolved" };

/** The wallet an account with this pin and key kind creates in. */
export const createWalletOf = (
  organization: string | null,
  keyKind: string | null,
): BoatCreateWallet =>
  organization !== null
    ? { kind: "known", wallet: organization }
    : keyKind === "organization"
      ? { kind: "known", wallet: null }
      : { kind: "unresolved" };

/** The columns a new object records its wallet in. */
export const recordedWallet = (wallet: {
  readonly kind: "known";
  readonly wallet: string | null;
}) => ({ boatWallet: wallet.wallet, boatWalletState: "known" }) as const;

/**
 * The install's own key's wallet. No `boat_install` row at all: a database no Boat install ever
 * started on (tests, an install without Boat), where nothing names a wallet.
 */
export const installCreateWallet = (db: DB) =>
  Effect.gen(function* () {
    const [row] = yield* db
      .select({ organization: boatInstall.organization, keyKind: boatInstall.keyKind })
      .from(boatInstall)
      .where(eq(boatInstall.id, "install"));
    return row === undefined
      ? ({ kind: "known", wallet: null } as const)
      : createWalletOf(row.organization, row.keyKind);
  });

/**
 * The wallet a deployment's account creates in: a stored account's (its row read `for share`, the
 * row its removal and its wallet change take `for update`), or the install's own when no stored
 * account has the deployment. `removing`: the account's removal was asked.
 */
export const deploymentCreateWallet = (db: DB, deploymentId: string) =>
  Effect.gen(function* () {
    const [account] = yield* db
      .select({
        removalRequestedAt: boatAccounts.removalRequestedAt,
        organization: boatAccounts.boatOrganization,
        keyKind: boatAccounts.keyKind,
      })
      .from(boatAccounts)
      .where(eq(boatAccounts.deploymentId, deploymentId))
      .for("share");
    if (account === undefined) return { removing: false, wallet: yield* installCreateWallet(db) };
    return {
      removing: account.removalRequestedAt !== null,
      wallet: createWalletOf(account.organization, account.keyKind),
    };
  });

/** Rows recorded as created in `wallet`. */
export const inWallet = (
  table: { readonly boatWallet: PgColumn; readonly boatWalletState: PgColumn },
  wallet: string | null,
): SQL | undefined =>
  and(
    eq(table.boatWalletState, "known"),
    wallet === null ? isNull(table.boatWallet) : eq(table.boatWallet, wallet),
  );

/** Rows recorded in a wallet other than `wallet` (known, so a request can name theirs). */
export const inOtherWallet = (
  table: { readonly boatWallet: PgColumn; readonly boatWalletState: PgColumn },
  wallet: string | null,
): SQL =>
  sql`(${table.boatWalletState} = 'known' and ${table.boatWallet} is distinct from ${wallet})`;
