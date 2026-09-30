/**
 * Keep-fresh sweeper for Codex logins (connected accounts of kind "auth-json") —
 * docs/connected-accounts-design.md §6a "One refresher".
 *
 * The store holds the only refresh token of a Codex login; every workspace and inference call runs
 * on a copy whose refresh token is a placeholder, so nothing else can rotate it. This sweeper keeps
 * the stored login fresh by the ONLY compliant means: the decrypted auth.json is materialized into
 * a private per-invocation CODEX_HOME (0700/0600) and the OFFICIAL Codex CLI is asked to refresh it
 * (`codex app-server` → `getAuthStatus { refreshToken: true, includeToken: true }`, which runs the
 * CLI's own refresh-token flow — no model request). The worker never calls OpenAI's token endpoint.
 * The rotated file is read back, persisted newest-wins, and pushed to running workspaces.
 *
 * Tested 2026-10-01 (Codex 0.159.2; the flag exists in the pinned 0.148.0): the refresh runs in
 * about a second; a Codex refresh leaves the previous access token valid, so the push has no
 * deadline beyond its expiry.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import {
  codexAuthJsonCanRefresh,
  codexAuthJsonCopy,
  parseCodexAuthJson,
  parseCodexCredentialPayload,
  provisionCodexHome,
  readCodexHomeAuthJson,
  removeCodexHome,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  SealantDB,
  WorkspaceRuntimeInstanceRepoLive,
  type ConnectedAccount,
  type DB,
} from "@sealant/db";
import {
  persistCodexAuthJsonIfNewer,
  pushCredentialCopy,
  type SealantTargetDerivationOptions,
} from "@sealant/workspaces";
import { Effect, Layer } from "effect";

/** How often the sweeper scans. A Codex access token lives about ten days. */
export const CODEX_SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

/** Refresh an access token that expires within this horizon (or already has). */
export const CODEX_SESSION_REFRESH_HORIZON_MS = 24 * 60 * 60 * 1_000;

/** With no readable access-token expiry, refresh a login older than this (Codex's own is 8 days). */
const CODEX_REFRESH_FALLBACK_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Hard cap on one refresh; a hung CLI must not wedge the sweep. */
const REFRESH_TIMEOUT_MS = 2 * 60 * 1_000;

/** How long one account's refresh (CLI, persist, push) may hold its claim. */
const REFRESH_CLAIM_MS = 10 * 60 * 1_000;

/** The access token's `exp` claim, in ms; undefined when the file or the JWT cannot be read. */
export const codexAccessTokenExpiresAt = (authJson: string): number | undefined => {
  try {
    const document = JSON.parse(authJson) as { tokens?: { access_token?: unknown } | null };
    const token = document.tokens?.access_token;
    if (typeof token !== "string") return undefined;
    const segment = token.split(".")[1];
    if (segment === undefined) return undefined;
    const claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
};

/** Selection rule, exported for tests. */
export const needsCodexSessionRefresh = (input: {
  readonly accessExpiresAt: number | undefined;
  readonly lastRefresh: number | undefined;
  readonly now: number;
}): boolean => {
  if (input.accessExpiresAt !== undefined) {
    return input.accessExpiresAt <= input.now + CODEX_SESSION_REFRESH_HORIZON_MS;
  }
  return (
    input.lastRefresh !== undefined && input.lastRefresh < input.now - CODEX_REFRESH_FALLBACK_AGE_MS
  );
};

/** The official CLI's JS launcher (the same pinned package the API's inference engine runs). */
const codexCommand = (): readonly string[] => {
  const require = createRequire(import.meta.url);
  return [process.execPath, require.resolve("@openai/codex/bin/codex.js")];
};

/** Subprocess env: ambient OpenAI identities stripped, the provisioned home injected. */
const buildEnv = (codexHome: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["OPENAI_API_KEY"];
  delete env["OPENAI_BASE_URL"];
  delete env["CODEX_API_KEY"];
  env["CODEX_HOME"] = codexHome;
  return env;
};

/**
 * Ask the official CLI to refresh the login in `codexHome`. Answers whether the CLI withheld the
 * token afterwards — what it does when the refresh was refused for good (the refresh token was
 * used, expired or revoked). Rejects on a crash or timeout: nothing was learned.
 */
const runCodexRefresh = (codexHome: string): Promise<{ readonly refusedForGood: boolean }> =>
  new Promise((resolve, reject) => {
    const [executable, ...leading] = codexCommand();
    if (executable === undefined) {
      reject(new Error("No Codex CLI to run."));
      return;
    }
    const child = spawn(executable, [...leading, "app-server"], {
      env: buildEnv(codexHome),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex refresh timed out."));
    }, REFRESH_TIMEOUT_MS);
    const finish = (outcome: { refusedForGood: boolean } | Error) => {
      clearTimeout(timer);
      child.kill();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`Codex app-server exited (${String(code)}).`)));
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error !== undefined) {
          finish(new Error(`Codex initialize failed: ${String(message.error.message)}`));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "getAuthStatus",
          params: { includeToken: true, refreshToken: true },
        });
        return;
      }
      if (message.id === 2) {
        if (message.error !== undefined) {
          finish(new Error(`Codex getAuthStatus failed: ${String(message.error.message)}`));
          return;
        }
        // The token itself is never kept or logged: only whether it was withheld.
        const result = message.result as { authMethod?: unknown; authToken?: unknown } | undefined;
        const withheld =
          result !== undefined &&
          result.authMethod !== null &&
          result.authMethod !== undefined &&
          (result.authToken === null || result.authToken === undefined);
        finish({ refusedForGood: withheld });
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "sealant-worker", version: "0.0.0" } },
    });
  });

/**
 * - `refreshed`: the CLI refreshed, the store has the new login, running workspaces got the copy.
 * - `refused`: the provider refused the refresh for good: the login is ended.
 * - `failed`: nothing was learned (a network fault, a crash); the next sweep tries again.
 */
export type CodexSessionRefreshOutcome = "refreshed" | "refused" | "fresh" | "skipped" | "failed";

const refreshOneAccount = Effect.fn("refreshCodexSessionAccount")(function* (input: {
  readonly account: ConnectedAccount;
  readonly credentialCipher: CredentialCipherService;
  readonly targetOptions: SealantTargetDerivationOptions;
  readonly now: number;
}) {
  const { account, credentialCipher, now } = input;
  const describe = `Codex auth.json (keep-fresh sweeper): account ${account.id}`;

  const outcome: CodexSessionRefreshOutcome = yield* Effect.gen(function* () {
    const plaintext = yield* credentialCipher.decrypt(account.encryptedPayload);
    const { authJson } = parseCodexCredentialPayload(JSON.parse(plaintext));

    // An API-key login has nothing to refresh; a stored copy would be a bug to report, not refresh.
    if (!codexAuthJsonCanRefresh(authJson)) {
      yield* Effect.logInfo(`${describe} skipped: the stored login has no refresh token.`);
      return "skipped" as const;
    }

    const parsed = parseCodexAuthJson(authJson);
    const lastRefresh =
      parsed.valid && parsed.metadata.lastRefresh !== undefined
        ? Date.parse(parsed.metadata.lastRefresh)
        : undefined;
    if (
      !needsCodexSessionRefresh({
        accessExpiresAt: codexAccessTokenExpiresAt(authJson),
        lastRefresh: Number.isNaN(lastRefresh ?? 0) ? undefined : lastRefresh,
        now,
      })
    ) {
      return "fresh" as const;
    }

    // One refresh per login at a time, across every worker.
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

    const provisioned = provisionCodexHome({ authJson });

    return yield* Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() => runCodexRefresh(provisioned.codexHome)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`${describe}: the refresh did not complete.`, cause).pipe(
            Effect.as(undefined),
          ),
        ),
      );

      const observed = readCodexHomeAuthJson(provisioned.codexHome);
      if (observed === undefined) {
        yield* Effect.logWarning(
          `${describe} failed-read: no readable auth.json after the refresh.`,
        );
        return "failed" as const;
      }

      const persisted = yield* persistCodexAuthJsonIfNewer({
        connectedAccountId: account.id,
        observedAuthJson: observed,
        credentialCipher,
        source: "keep-fresh sweeper",
      });

      if (persisted === "synced") {
        yield* pushCredentialCopy({
          connectedAccountId: account.id,
          provider: "codex",
          copyJson: codexAuthJsonCopy(observed),
          targetOptions: input.targetOptions,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`${describe}: pushing the refreshed copy failed.`, cause),
          ),
        );
        return "refreshed" as const;
      }

      if (result?.refusedForGood === true) {
        yield* accounts.markInvalid({ id: account.id });
        yield* Effect.logWarning(
          `${describe} refused: the provider refused the refresh for good — reconnect needed.`,
        );
        return "refused" as const;
      }
      return "failed" as const;
    }).pipe(
      Effect.ensuring(Effect.sync(() => removeCodexHome(provisioned.codexHome))),
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

export interface RefreshCodexSessionCredentialsOptions {
  readonly db: DB;
  readonly credentialCipher: CredentialCipherService;
  /** How the push reaches running workspaces (the worker's own target derivation). */
  readonly targetOptions?: SealantTargetDerivationOptions;
}

/** One sweep at a time per worker process; the claim covers other workers. */
let sweepInProgress = false;

/**
 * One sweeper tick: scan active Codex auth-json accounts and refresh every one due. Returns the
 * number refreshed. Never rejects on per-account trouble; only infrastructure failures reject.
 */
export const refreshCodexSessionCredentials = async (
  options: RefreshCodexSessionCredentialsOptions,
): Promise<number> => {
  if (sweepInProgress) {
    return 0;
  }
  sweepInProgress = true;

  const dataAccessLayer = Layer.mergeAll(
    ConnectedAccountRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, options.db)));

  const program = Effect.gen(function* () {
    const accounts = yield* ConnectedAccountRepo;
    const candidates = yield* accounts.listActiveByProviderKind({
      provider: "codex",
      kind: "auth-json",
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
                `keep-fresh sweeper: could not record the Codex refresh outcome for ${account.id}.`,
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
