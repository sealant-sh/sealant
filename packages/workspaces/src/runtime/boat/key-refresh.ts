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
import { Effect, Option } from "effect";

import { HttpBoatApi } from "./api.js";
import { BoatSecret, type BoatResult } from "./config.js";
import { observeBoatKey, type BoatKeyCheckClient } from "./key-check.js";

/** Once a day: enough to see an expiry approaching or an account suspended. */
export const BOAT_KEY_REFRESH_MS = 24 * 3_600_000;

/** The wallet a report observed can start a VM now: a cause a person fixed may have cleared. */
export const boatReportCanStart = (report: BoatKeyReport): boolean =>
  report.start.observed && report.start.canStart;

/**
 * Reopens the deployment's quarantined builds whose Boat reason a person fixes, so the next launch
 * tries each once more. Answers how many were reopened.
 */
export const reopenBoatQuarantine = (db: DB, deploymentId: string, at: Date = new Date()) =>
  Effect.runPromise(
    Effect.flatMap(BoatAccountRepo, (repo) => repo.reopenQuarantined({ deploymentId, at })).pipe(
      Effect.provide(BoatAccountRepoLive),
      Effect.provideService(SealantDB, db),
    ),
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

  /** Opens a stored account's sealed key; `undefined` when it does not open. */
  const storedKey = async (accountId: string) => {
    const sealed = await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(accountId)));
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
      if (deploymentId !== undefined && boatReportCanStart(report))
        await reopenBoatQuarantine(options.db, deploymentId, now()).catch(() => 0);
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
