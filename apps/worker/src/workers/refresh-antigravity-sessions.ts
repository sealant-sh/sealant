/**
 * Keep-fresh sweeper for Antigravity personal Google OAuth logins (kind "antigravity-token") —
 * docs/connected-accounts-design.md §6a "One refresher".
 *
 * Google OAuth access tokens expire after 60 minutes, and `agy acp` rejects `session/new` once a
 * token without `refresh_token` is within 5 minutes of expiry. The store holds the only
 * `refresh_token`; workspaces receive a stripped access-token-only copy. This sweeper scans every
 * 10 minutes with a 20-minute horizon, materializes the stored token with a past `token.expiry`
 * into a private 0700 HOME, runs `agy models` (zero LLM tokens), persists the refreshed token
 * newest-wins, and pushes the new stripped copy to every running workspace and home holding it.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  antigravityTokenCanRefresh,
  antigravityTokenCopy,
  parseAntigravityTokenJson,
  parseAntigravityTokenPayload,
  provisionAntigravityHome,
  readAntigravityHomeToken,
  readStoredAntigravityExpiresAt,
  removeAntigravityHome,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  CredentialPlacementRepoLive,
  SealantDB,
  WorkspaceCredentialHomeRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type ConnectedAccount,
  type DB,
} from "@sealant/db";
import {
  persistAntigravityTokenIfNewer,
  pushCredentialCopy,
  type SealantTargetDerivationOptions,
} from "@sealant/workspaces";
import { Effect, Layer, Predicate } from "effect";

/** How often the sweeper scans. Google access tokens live 60 minutes. */
export const ANTIGRAVITY_SESSION_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Refresh any token expiring within 20 minutes (or already expired): two sweep windows ahead of
 * `agy`'s 5-minute client refresh buffer.
 */
export const ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS = 20 * 60 * 1_000;

/** How long one account's refresh (CLI, persist, push) may hold its claim. */
const REFRESH_CLAIM_MS = 5 * 60 * 1_000;

/** Hard cap on one `agy models` refresh; a hung CLI must not wedge the sweep. */
const REFRESH_TIMEOUT_MS = 60 * 1_000;

const AUTH_REFUSED_PATTERN = /please sign in|invalid_grant|authentication required/i;

/** Selection rule, exported for tests. */
export const needsAntigravitySessionRefresh = (
  storedExpiresAt: number | undefined,
  now: number = Date.now(),
): boolean => {
  return (
    storedExpiresAt !== undefined && storedExpiresAt <= now + ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS
  );
};

/**
 * The private copy `agy models` runs on: the stored file WITH its `refresh_token`, with
 * `token.expiry` marked 2 minutes in the past so the CLI refreshes immediately rather than waiting
 * for its internal 5-minute threshold.
 */
export const antigravityDueForRefresh = (tokenJson: string, now: number): string => {
  const parsed: unknown = JSON.parse(tokenJson);
  const document = Predicate.isObject(parsed) ? parsed : {};
  const token = Predicate.isObject(document["token"]) ? document["token"] : {};
  return JSON.stringify({
    ...document,
    token: { ...token, expiry: new Date(now - 2 * 60_000).toISOString() },
  });
};

const buildEnv = (home: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["GOOGLE_API_KEY"];
  delete env["GEMINI_API_KEY"];
  delete env["ANTIGRAVITY_API_KEY"];
  env["HOME"] = home;
  env["XDG_CONFIG_HOME"] = join(home, ".config");
  env["XDG_CACHE_HOME"] = join(home, ".cache");
  return env;
};

export interface AntigravityRefreshCommandResult {
  readonly exitCode: number | null;
  readonly refusedForGood: boolean;
}

export type RunAntigravityRefresh = (home: string) => Promise<AntigravityRefreshCommandResult>;

const defaultRunAntigravityRefresh: RunAntigravityRefresh = (home) =>
  new Promise((resolve, reject) => {
    const executable = process.env["ANTIGRAVITY_CLI_PATH"]?.trim() || "agy";
    const child = spawn(executable, ["models"], {
      env: buildEnv(home),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Antigravity refresh (`agy models`) timed out."));
    }, REFRESH_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        refusedForGood: exitCode !== 0 && AUTH_REFUSED_PATTERN.test(stderr),
      });
    });
  });

/**
 * - `refreshed`: the CLI refreshed, the store has the new login, running workspaces got the copy.
 * - `refused`: Google refused the refresh token (revoked/expired): the login is marked invalid.
 * - `failed`: nothing was learned (network error, missing binary, crash); next sweep tries again.
 */
export type AntigravitySessionRefreshOutcome =
  | "refreshed"
  | "refused"
  | "fresh"
  | "skipped"
  | "failed";

const refreshOneAccount = Effect.fn("refreshAntigravitySessionAccount")(function* (input: {
  readonly account: ConnectedAccount;
  readonly credentialCipher: CredentialCipherService;
  readonly targetOptions: SealantTargetDerivationOptions;
  readonly now: number;
  readonly runRefresh?: RunAntigravityRefresh;
}) {
  const { account, credentialCipher, now } = input;
  const describe = `Antigravity OAuth token (keep-fresh sweeper): account ${account.id}`;

  const outcome: AntigravitySessionRefreshOutcome = yield* Effect.gen(function* () {
    const plaintext = yield* credentialCipher.decrypt(account.encryptedPayload);
    const payload = parseAntigravityTokenPayload(JSON.parse(plaintext));

    if (!antigravityTokenCanRefresh(payload.tokenJson)) {
      yield* Effect.logInfo(`${describe} skipped: the stored login has no refresh_token.`);
      return "skipped" as const;
    }

    const parsed = parseAntigravityTokenJson(payload.tokenJson);
    const storedExpiresAt =
      (parsed.valid ? parsed.metadata.expiresAt : undefined) ??
      readStoredAntigravityExpiresAt(account.metadata);

    if (!needsAntigravitySessionRefresh(storedExpiresAt, now)) {
      return "fresh" as const;
    }

    const accounts = yield* ConnectedAccountRepo;
    const claimed = yield* accounts.claimRefresh({
      id: account.id,
      until: new Date(now + REFRESH_CLAIM_MS),
      now: new Date(now),
    });
    if (!claimed) {
      yield* Effect.logInfo(`${describe} skipped-claimed: another refresher holds this login.`);
      return "skipped" as const;
    }

    const provisioned = provisionAntigravityHome({
      tokenJson: antigravityDueForRefresh(payload.tokenJson, now),
    });

    return yield* Effect.gen(function* () {
      const runRefresh = input.runRefresh ?? defaultRunAntigravityRefresh;
      const result = yield* Effect.tryPromise(() => runRefresh(provisioned.home)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`${describe}: the refresh did not complete.`, cause).pipe(
            Effect.as(undefined),
          ),
        ),
      );

      const observed = readAntigravityHomeToken(provisioned.home);
      if (observed === undefined) {
        yield* Effect.logWarning(
          `${describe} failed-read: no readable antigravity-oauth-token after the refresh.`,
        );
        return "failed" as const;
      }

      const persisted = yield* persistAntigravityTokenIfNewer({
        connectedAccountId: account.id,
        observedTokenJson: observed,
        credentialCipher,
        source: "keep-fresh sweeper",
        sourceRevision: account.credentialRevision,
      });

      if (persisted === "synced") {
        yield* pushCredentialCopy({
          connectedAccountId: account.id,
          provider: "antigravity",
          copyJson: antigravityTokenCopy(observed),
          targetOptions: input.targetOptions,
          credentialCipher,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`${describe}: pushing the refreshed copy failed.`, cause),
          ),
        );
        return "refreshed" as const;
      }
      if (persisted === "skipped-superseded") return "skipped" as const;

      if (result?.refusedForGood === true) {
        yield* accounts.markInvalid({ id: account.id, revision: account.credentialRevision });
        yield* Effect.logWarning(
          `${describe} refused: Google refused the refresh token — reconnect needed.`,
        );
        return "refused" as const;
      }
      return "failed" as const;
    }).pipe(
      Effect.ensuring(Effect.sync(() => removeAntigravityHome(provisioned.home))),
      Effect.ensuring(accounts.releaseRefresh({ id: account.id }).pipe(Effect.ignore)),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${describe} failed: refresh crashed.`, cause).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );

  return outcome;
});

export interface RefreshAntigravitySessionCredentialsOptions {
  readonly db: DB;
  readonly credentialCipher: CredentialCipherService;
  /** How the push reaches running workspaces (the worker's own target derivation). */
  readonly targetOptions?: SealantTargetDerivationOptions;
}

/** One sweep at a time per worker process; the DB claim covers other workers. */
let sweepInProgress = false;

/**
 * One sweeper tick: scan active Antigravity accounts and refresh every one due. Returns the number
 * refreshed. Never rejects on per-account trouble; only infrastructure failures reject.
 */
export const refreshAntigravitySessionCredentials = async (
  options: RefreshAntigravitySessionCredentialsOptions,
): Promise<number> => {
  if (sweepInProgress) {
    return 0;
  }
  sweepInProgress = true;

  const dataAccessLayer = Layer.mergeAll(
    ConnectedAccountRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceCredentialHomeRepoLive,
    CredentialPlacementRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, options.db)));

  const program = Effect.gen(function* () {
    const accounts = yield* ConnectedAccountRepo;
    const candidates = yield* accounts.listActiveByProviderKind({
      provider: "antigravity",
      kind: "antigravity-token",
    });
    const now = Date.now();

    let refreshed = 0;
    for (const account of candidates) {
      const outcome = yield* refreshOneAccount({
        account,
        credentialCipher: options.credentialCipher,
        targetOptions: options.targetOptions ?? {},
        now,
      });
      if (outcome === "refreshed") refreshed += 1;
      if (outcome !== "skipped" && outcome !== "fresh") {
        yield* accounts
          .updateSyncState({
            id: account.id,
            metadata: { ...account.metadata, lastRefreshOutcome: outcome },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `keep-fresh sweeper: could not record the Antigravity refresh outcome for ${account.id}.`,
                cause,
              ),
            ),
          );
      }
    }
    return refreshed;
  });

  try {
    return await Effect.runPromise(program.pipe(Effect.provide(dataAccessLayer)));
  } finally {
    sweepInProgress = false;
  }
};

export { refreshOneAccount as refreshAntigravitySessionAccount };
