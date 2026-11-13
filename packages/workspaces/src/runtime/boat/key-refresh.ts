import type { BoatKeyReport } from "@sealant/api-contracts";
/**
 * Keeps every Boat key's report fresh without anyone asking: the install's own key and each stored
 * account's are checked against Boat (read-only) once their last report is older than
 * `everyMs`, and the new report replaces it. A key Boat now refuses is reported as refused; a check
 * Boat does not answer keeps the last report. Nothing here creates, changes or deletes anything in
 * Boat, and no key reaches a report, a log or an error.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import { BoatAccountRepo, BoatAccountRepoLive, SealantDB, type DB } from "@sealant/db";
import type { NativeReopenReason } from "@sealant/validators";
import { Effect, Option } from "effect";

import { HttpBoatApi } from "./api.js";
import { BoatSecret, type BoatResult } from "./config.js";
import { observeBoatKey, type BoatKeyCheckClient } from "./key-check.js";

/** Once a day: enough to see an expiry approaching or an account suspended. */
export const BOAT_KEY_REFRESH_MS = 24 * 3_600_000;

/**
 * The quarantine reasons (`NATIVE_REOPEN_BOAT_FAILURES`) whose cause a report shows cleared, each by
 * what Boat itself answered: the key is accepted now (Boat showed who it is); the permissions
 * sealant needs are all held and the key reaches every VM; the account is active; the wallet can
 * start a VM; a saved snapshot slot is free. A cause the report did not observe is not cleared. A
 * key rotation reopens every reason (`reopenBoatQuarantine` with no `reasons`).
 */
export const boatReopenableReasons = (report: BoatKeyReport): readonly NativeReopenReason[] => {
  const reasons: NativeReopenReason[] = [];
  const { identity, permissions, start, snapshots } = report;
  if (identity.observed)
    reasons.push(
      "native-boat-key-refused",
      "native-boat-key-expired",
      "native-boat-organization-mismatch",
    );
  if (permissions.observed && !permissions.limitedToSandboxes)
    reasons.push("native-boat-sandbox-outside-key");
  if (permissions.observed && permissions.missing.length === 0)
    reasons.push("native-boat-permission-missing");
  if (identity.observed && identity.accountStatus === "active")
    reasons.push("native-boat-account-suspended");
  if (start.observed && start.canStart)
    reasons.push(
      "native-boat-billing-required",
      "native-boat-member-cap",
      "native-boat-trial-restricted",
    );
  if (snapshots.observed && snapshots.used < snapshots.included)
    reasons.push("native-boat-snapshot-allowance-full");
  return reasons;
};

/**
 * Reopens the deployment's quarantined builds whose Boat reason a person fixes, so the next launch
 * tries each once more: those of `reasons` (what a report shows cleared), or every such reason (a
 * key rotation). Answers how many were reopened.
 */
export const reopenBoatQuarantine = (
  db: DB,
  deploymentId: string,
  at: Date = new Date(),
  reasons?: readonly NativeReopenReason[],
) =>
  Effect.runPromise(
    Effect.flatMap(BoatAccountRepo, (repo) =>
      repo.reopenQuarantined({ deploymentId, at, ...(reasons === undefined ? {} : { reasons }) }),
    ).pipe(Effect.provide(BoatAccountRepoLive), Effect.provideService(SealantDB, db)),
  );

/** The account id of the install's own key in `boat_key_reports`. */
const DEFAULT_ACCOUNT = "default";

export interface BoatKeyRefreshOptions {
  readonly db: DB;
  readonly cipher: CredentialCipherService;
  /** The install's own key and the organization it names; absent: the install has none. */
  readonly defaultKey?: {
    readonly credential: BoatSecret;
    readonly organization: string | undefined;
    /** The install's own deployment label: its quarantined builds are reopened by its checks. */
    readonly deploymentId?: string;
  };
  /** How a key is opened into the client its check reads with. Default: Boat's real API. */
  readonly clientFor?: (
    credential: BoatSecret,
    options?: { readonly organization?: string },
  ) => BoatResult<BoatKeyCheckClient>;
  /** How old a report may get before the key is checked again. Default once a day. */
  readonly everyMs?: number;
  readonly now?: () => Date;
}

/**
 * One key's pass: `refreshed` (a new report is stored), `kept` (Boat did not answer; the last
 * report stays), `fresh` (its report is recent enough), `unavailable` (its key could not be opened
 * or its report not stored; tried again next pass).
 */
export interface BoatKeyRefreshOutcome {
  readonly account: string;
  readonly outcome: "refreshed" | "kept" | "fresh" | "unavailable";
}

/** Opens a stored account's sealed key, with its organization; `undefined` when it does not open. */
export const openStoredBoatKey = async (
  options: { readonly db: DB; readonly cipher: CredentialCipherService },
  accountId: string,
): Promise<
  { readonly credential: BoatSecret; readonly organization: string | undefined } | undefined
> => {
  const sealed = await Effect.runPromise(
    Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(accountId)).pipe(
      Effect.provide(BoatAccountRepoLive),
      Effect.provideService(SealantDB, options.db),
    ),
  );
  if (sealed === undefined) return undefined;
  const opened = await Effect.runPromise(
    options.cipher.decrypt(sealed.sealedKey).pipe(Effect.option),
  );
  if (Option.isNone(opened)) return undefined;
  const credential = BoatSecret.parse(opened.value);
  return credential.ok
    ? { credential: credential.value, organization: sealed.organization ?? undefined }
    : undefined;
};

const defaultClientFor: NonNullable<BoatKeyRefreshOptions["clientFor"]> = (credential, options) =>
  HttpBoatApi.create({
    credential,
    ...(options?.organization === undefined ? {} : { organization: options.organization }),
  });

/**
 * One pass over every key: each whose report is missing or older than `everyMs` is checked, one
 * after another. `force` checks the named accounts whatever their report's age (the worker checks
 * the install's own key when it starts). One key failing stops no other.
 */
export const refreshBoatKeyReports = async (
  options: BoatKeyRefreshOptions,
  pass: { readonly force?: readonly string[] } = {},
): Promise<readonly BoatKeyRefreshOutcome[]> => {
  const now = options.now ?? (() => new Date());
  const everyMs = options.everyMs ?? BOAT_KEY_REFRESH_MS;
  const clientFor = options.clientFor ?? defaultClientFor;
  const run = <A, E>(effect: Effect.Effect<A, E, BoatAccountRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(BoatAccountRepoLive),
        Effect.provideService(SealantDB, options.db),
      ),
    );
  const [reports, accounts] = await Promise.all([
    run(Effect.flatMap(BoatAccountRepo, (repo) => repo.reports())),
    run(Effect.flatMap(BoatAccountRepo, (repo) => repo.list())),
  ]);
  const due = (account: string) => {
    if (pass.force?.includes(account) === true) return true;
    const last = reports.get(account);
    return last === undefined || now().getTime() - last.observedAt.getTime() >= everyMs;
  };

  const storedKey = (accountId: string) => openStoredBoatKey(options, accountId);

  const refresh = async (
    account: string,
    deploymentId: string | undefined,
    key: () => Promise<
      { readonly credential: BoatSecret; readonly organization: string | undefined } | undefined
    >,
  ): Promise<BoatKeyRefreshOutcome> => {
    if (!due(account)) return { account, outcome: "fresh" };
    try {
      const opened = await key();
      if (opened === undefined) return { account, outcome: "unavailable" };
      const client = clientFor(
        opened.credential,
        opened.organization === undefined ? undefined : { organization: opened.organization },
      );
      if (!client.ok) return { account, outcome: "unavailable" };
      const observed = await observeBoatKey(client.value, {
        organization: opened.organization ?? null,
        now,
      });
      if (observed.kind === "kept") return { account, outcome: "kept" };
      const report = observed.report;
      await run(
        Effect.flatMap(BoatAccountRepo, (repo) =>
          repo.saveReport({ account, report, observedAt: new Date(report.observedAt) }),
        ),
      );
      const cleared = boatReopenableReasons(report);
      if (deploymentId !== undefined && cleared.length > 0)
        await reopenBoatQuarantine(options.db, deploymentId, now(), cleared).catch(() => 0);
      return { account, outcome: "refreshed" };
    } catch {
      return { account, outcome: "unavailable" };
    }
  };

  const outcomes: BoatKeyRefreshOutcome[] = [];
  const defaultKey = options.defaultKey;
  if (defaultKey !== undefined)
    outcomes.push(
      await refresh(DEFAULT_ACCOUNT, defaultKey.deploymentId, () => Promise.resolve(defaultKey)),
    );
  for (const account of accounts) {
    // An account being removed is going away: its key is not checked again.
    if (account.removalRequestedAt !== null) continue;
    outcomes.push(await refresh(account.id, account.deploymentId, () => storedKey(account.id)));
  }
  return outcomes;
};
