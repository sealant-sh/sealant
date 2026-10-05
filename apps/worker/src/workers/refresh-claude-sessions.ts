/**
 * Keep-fresh sweeper for claude SESSION credentials (kind "credentials-json").
 *
 * Session access tokens live hours. Refresh used to be coupled solely to workspace activity, so an
 * account that sat idle went stale and every point-of-use consumer met an expired token first. This
 * sweeper periodically refreshes any active session account whose stored `claudeAiOauth.expiresAt`
 * is past or near — by the ONLY compliant means (docs/connected-accounts-design.md §2): the
 * decrypted file is materialized into a private per-invocation `CLAUDE_CONFIG_DIR` (0700/0600) and
 * the OFFICIAL Claude Code CLI (via the Agent SDK) is run against it with a minimal one-turn
 * prompt. The CLI rotates the session itself; the worker never calls Anthropic's token endpoint.
 * The rotated file is read back and persisted through the same newest-wins guards as the workspace
 * sync-back. The ping deliberately spends a trivial slice of the user's subscription — explicitly
 * approved trade-off for tokens that stay fresh.
 */
import { tmpdir } from "node:os";

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeCredentialsCanRefresh,
  claudeCredentialsCopy,
  parseClaudeCredentialPayload,
  parseClaudeCredentialsJson,
  provisionClaudeConfigDir,
  readClaudeConfigDirCredentials,
  readStoredClaudeExpiresAt,
  removeClaudeConfigDir,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  SealantDB,
  WorkspaceCredentialHomeRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type ConnectedAccount,
  type DB,
} from "@sealant/db";
import {
  persistClaudeCredentialsIfNewer,
  pushCredentialCopy,
  type SealantTargetDerivationOptions,
} from "@sealant/workspaces";
import { Effect, Layer } from "effect";

/** How often the sweeper scans for stale session credentials. */
export const CLAUDE_SESSION_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * Refresh anything expiring within this horizon (or already expired). An hour ahead of an access
 * token that lives about eight: four sweeps' worth of retries before a running session's copy
 * expires (docs/connected-accounts-design.md §6a).
 */
export const CLAUDE_SESSION_REFRESH_HORIZON_MS = 60 * 60 * 1_000;

/** How long one account's refresh (ping, persist, push) may hold its claim. */
const REFRESH_CLAIM_MS = 10 * 60 * 1_000;

/** Hard cap on one refresh ping; a hung CLI must not wedge the sweep. */
const REFRESH_PING_TIMEOUT_MS = 3 * 60 * 1_000;

/** Cheapest possible exchange: one turn, no tools, a single-token answer. */
const REFRESH_PING_PROMPT = "Reply with exactly: ok";

/**
 * Selection rule, exported for tests: refresh when a stored expiry exists and is past or within
 * the horizon. No stored expiry means staleness cannot be judged — leave the account alone (the
 * point-of-use paths still refresh it when it is actually consumed).
 */
export const needsClaudeSessionRefresh = (
  storedExpiresAt: number | undefined,
  now: number = Date.now(),
): boolean => {
  return (
    storedExpiresAt !== undefined && storedExpiresAt <= now + CLAUDE_SESSION_REFRESH_HORIZON_MS
  );
};

/**
 * Subprocess env for the refresh ping — same stripping as the inference engine: no ambient
 * Anthropic identity may bill the exchange, and no ambient CLAUDE_CODE_OAUTH_TOKEN may shadow the
 * provisioned config dir (which would disable the CLI's file-based refresh).
 */
const buildPingEnv = (configDir: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  delete env["ANTHROPIC_PROFILE"];
  delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  env["CLAUDE_CONFIG_DIR"] = configDir;
  env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "sealant-worker";
  return env;
};

/**
 * One minimal official-CLI exchange against the provisioned config dir. The RESULT text is
 * irrelevant — the exchange exists so the CLI authenticates from the session file and rotates it.
 * Failures propagate to the caller, which still reads the file back (the CLI may have refreshed
 * before failing).
 */
const runRefreshPing = async (configDir: string): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Claude session refresh ping timed out."));
  }, REFRESH_PING_TIMEOUT_MS);
  try {
    const exchange = query({
      prompt: REFRESH_PING_PROMPT,
      options: {
        env: buildPingEnv(configDir),
        cwd: tmpdir(),
        tools: [],
        settingSources: [],
        includePartialMessages: false,
        maxTurns: 1,
        abortController: controller,
      },
    });
    // Drain to completion; only the CLI-side session rotation matters, not the reply.
    for await (const message of exchange) {
      void message;
    }
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The private copy the ping runs on: the stored file WITH its refresh token (this is the one place
 * it goes), its `expiresAt` marked as passed so the official CLI refreshes on this exchange rather
 * than at a moment of its own choosing. Tested 2026-10-01 (Claude Code 2.1.286): an expired
 * `expiresAt` with a refresh token present makes the CLI refresh before the request.
 */
const dueForRefresh = (credentialsJson: string, now: number): string => {
  const document = JSON.parse(credentialsJson) as Record<string, unknown>;
  const grant = document["claudeAiOauth"] as Record<string, unknown>;
  return JSON.stringify({ ...document, claudeAiOauth: { ...grant, expiresAt: now - 60_000 } });
};

/**
 * - `refreshed`: the CLI refreshed, the store has the new login, running workspaces got the copy.
 * - `refused`: the provider refused the refresh (the CLI cleared the file): the login is ended.
 * - `failed`: nothing was learned (a network fault, a crash); the next sweep tries again.
 */
export type ClaudeSessionRefreshOutcome = "refreshed" | "refused" | "fresh" | "skipped" | "failed";

/**
 * Refresh one account if (and only if) its stored session file is stale. Never fails; the shared
 * persist core logs the per-account outcome line, and abnormal conditions warn here.
 */
const refreshOneAccount = Effect.fn("refreshClaudeSessionAccount")(function* (input: {
  readonly account: ConnectedAccount;
  readonly credentialCipher: CredentialCipherService;
  readonly targetOptions: SealantTargetDerivationOptions;
  readonly now: number;
}) {
  const { account, credentialCipher, now } = input;
  const describe = `Claude credentials (keep-fresh sweeper): account ${account.id}`;

  const outcome: ClaudeSessionRefreshOutcome = yield* Effect.gen(function* () {
    const plaintext = yield* credentialCipher.decrypt(account.encryptedPayload);
    const payload = parseClaudeCredentialPayload(JSON.parse(plaintext));

    // Shape dispatch, never the db `kind` column: a reconnect may have switched shapes.
    if ("token" in payload) {
      yield* Effect.logInfo(
        `${describe} skipped-not-session-file: stored payload is a setup token despite kind credentials-json.`,
      );
      return "skipped" as const;
    }

    const storedParsed = parseClaudeCredentialsJson(payload.credentialsJson);
    const storedExpiresAt =
      (storedParsed.valid ? storedParsed.metadata.expiresAt : undefined) ??
      readStoredClaudeExpiresAt(account.metadata);

    if (!needsClaudeSessionRefresh(storedExpiresAt, now)) {
      return "fresh" as const;
    }

    // One refresh per login at a time, across every worker: a second refresher would spend the
    // refresh token this one is using.
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

    // Materialize (refresh token included, due now) -> official-CLI ping -> read back -> persist
    // newest-wins -> push the copy -> remove the dir -> release the claim.
    const provisioned = provisionClaudeConfigDir({
      credentialsJson: dueForRefresh(payload.credentialsJson, now),
    });

    return yield* Effect.gen(function* () {
      const pingError = yield* Effect.tryPromise(() => runRefreshPing(provisioned.configDir)).pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      );

      if (pingError !== undefined) {
        // Still read the file back below: the CLI may have rotated the session before failing.
        yield* Effect.logWarning(
          `${describe}: refresh ping did not complete cleanly; checking for a rotation anyway.`,
          pingError,
        );
      }

      const observed = readClaudeConfigDirCredentials(provisioned.configDir);

      if (observed === undefined) {
        yield* Effect.logWarning(
          `${describe} failed-read: provisioned config dir has no readable .credentials.json after the ping.`,
        );
        return "failed" as const;
      }

      // A refused refresh clears the grant from the file (tested: "OAuth session expired and could
      // not be refreshed" leaves no access or refresh token). The login is over: say so.
      if (!claudeCredentialsCanRefresh(observed)) {
        yield* accounts.markInvalid({ id: account.id });
        yield* Effect.logWarning(
          `${describe} refused: the provider refused the refresh and the CLI cleared the login — reconnect needed.`,
        );
        return "refused" as const;
      }

      const persisted = yield* persistClaudeCredentialsIfNewer({
        connectedAccountId: account.id,
        observedCredentialsJson: observed,
        credentialCipher,
        source: "keep-fresh sweeper",
      });
      if (persisted !== "synced") return "failed" as const;

      // The previous access token is revoked now: running workspaces get the new copy at once.
      yield* pushCredentialCopy({
        connectedAccountId: account.id,
        provider: "claude",
        copyJson: claudeCredentialsCopy(observed),
        targetOptions: input.targetOptions,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${describe}: pushing the refreshed copy failed.`, cause),
        ),
      );
      return "refreshed" as const;
    }).pipe(
      Effect.ensuring(Effect.sync(() => removeClaudeConfigDir(provisioned.configDir))),
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

export interface RefreshClaudeSessionCredentialsOptions {
  readonly db: DB;
  readonly credentialCipher: CredentialCipherService;
  /** How the push reaches running workspaces (the worker's own target derivation). */
  readonly targetOptions?: SealantTargetDerivationOptions;
}

/**
 * Concurrency guard: one sweep at a time per worker process. A refresh must never run twice
 * concurrently for the same account — concurrent rotations of one session can brick it — and
 * within a sweep the accounts are processed strictly sequentially.
 */
let sweepInProgress = false;

/**
 * One sweeper tick: scan active claude credentials-json accounts and refresh every stale one.
 * Returns the number of accounts refreshed. Never rejects on per-account trouble (warnings only);
 * only infrastructure failures (db unreachable) reject, which the caller logs.
 */
export const refreshClaudeSessionCredentials = async (
  options: RefreshClaudeSessionCredentialsOptions,
): Promise<number> => {
  if (sweepInProgress) {
    return 0;
  }
  sweepInProgress = true;

  const dataAccessLayer = Layer.mergeAll(
    ConnectedAccountRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceCredentialHomeRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, options.db)));

  const program = Effect.gen(function* () {
    const accounts = yield* ConnectedAccountRepo;
    const candidates = yield* accounts.listActiveByProviderKind({
      provider: "claude",
      kind: "credentials-json",
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
      if (outcome === "refreshed") {
        refreshed += 1;
      }
      // Record what this sweep did, so a surface can report freshness as an observation instead
      // of parsing a payload it must never see (Mend's ADR 0005). `skipped` is not recorded: it
      // means this sweep had nothing to say about the credential.
      if (outcome !== "skipped") {
        yield* accounts
          .updateSyncState({
            id: account.id,
            metadata: { ...account.metadata, lastRefreshOutcome: outcome },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `keep-fresh sweeper: could not record the refresh outcome for ${account.id}.`,
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
