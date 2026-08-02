import {
  isNewerClaudeCredentials,
  isPlausibleClaudeExpiry,
  parseClaudeCredentialPayload,
  parseClaudeCredentialsJson,
  parseConnectedAccountRef,
  readStoredClaudeExpiresAt,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import { ConnectedAccountRepo } from "@sealant/db";
import type { NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";

/*
Claude .credentials.json sync-back, sibling of codex-auth-sync-back.ts. When a claude connected
account stores a SESSION credentials file (kind "credentials-json"), the official Claude Code CLI
inside the workspace refreshes the session and rewrites $HOME/.claude/.credentials.json. After a
run completes (and on workspace stop/reap, before the container is destroyed), the worker reads
the file back and persists it — but ONLY when its `claudeAiOauth.expiresAt` is strictly newer
than the stored copy's (newest-wins; an equal-or-older copy could clobber a fresher rotation
persisted by another run). The guards themselves (`isNewerClaudeCredentials`,
`isPlausibleClaudeExpiry`, `readStoredClaudeExpiresAt`) live in @sealant/credentials — the
inference engine and the keep-fresh sweeper persist CLI-rotated files through the exact same
rules via {@link persistClaudeCredentialsIfNewer}.

Lineage guards (a workspace file is only trusted when Sealant put a file there):
- Launch-shape gate: sync-back runs ONLY for accounts recorded as FILE-injected at THIS
  workspace's launch (`launchFileInjectedAccountIds`, from the runtime instance row). Env-injected
  workspaces never sync claude — a harness may fabricate $HOME/.claude/.credentials.json in them
  (e.g. a seeded setup-token file), and a mid-run token→file reconnect must not let that fabricated
  file clobber the freshly pasted session.
- Plausibility belt: an observed `expiresAt` more than 30 days ahead of now is rejected outright.
  Real session tokens live hours; a far-future value is a sentinel, and persisting one would make
  the strictly-greater guard freeze out every real rotation afterward.
- Stored-shape belt: the decrypted STORED payload must itself be a session file; setup-token
  accounts are never silently converted.

Everything here is best-effort: the run already completed, so a failed sync-back (container gone,
unreadable file, repo hiccup) degrades to a logged warning, never a job failure. Every considered
account produces exactly ONE outcome log line (synced / skipped-<reason> / failed) so a silent
skip can never masquerade as a sync.
*/

export {
  isNewerClaudeCredentials,
  isPlausibleClaudeExpiry,
  MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS,
  readStoredClaudeExpiresAt,
} from "@sealant/credentials";

/** One-line outcome of a persist attempt; the reason string lands verbatim in the log line. */
export type ClaudeCredentialsPersistOutcome =
  | "synced"
  | "skipped-invalid-file"
  | "skipped-implausible-expiry"
  | "skipped-account-unavailable"
  | "skipped-not-session-file"
  | "skipped-not-newer"
  | "failed";

export interface PersistClaudeCredentialsIfNewerInput {
  readonly connectedAccountId: string;
  /** The observed (possibly CLI-rotated) .credentials.json contents. */
  readonly observedCredentialsJson: string;
  readonly credentialCipher: CredentialCipherService;
  /** Names the observation path in the outcome log line (e.g. "run-exec sync-back"). */
  readonly source: string;
}

/**
 * The shared persist core: decide whether an observed .credentials.json may replace the stored
 * copy (parse → plausibility belt → stored-shape belt → newest-wins) and write it if so. Used by
 * the workspace sync-backs, the inference engine's point-of-use refresh, and the keep-fresh
 * sweeper. Never fails; every call logs exactly one outcome line and returns the outcome.
 */
export const persistClaudeCredentialsIfNewer = Effect.fn("persistClaudeCredentialsIfNewer")(
  function* (input: PersistClaudeCredentialsIfNewerInput) {
    const describe = `Claude credentials (${input.source}): account ${input.connectedAccountId}`;

    const outcome: ClaudeCredentialsPersistOutcome = yield* Effect.gen(function* () {
      const parsed = parseClaudeCredentialsJson(input.observedCredentialsJson);

      if (!parsed.valid) {
        yield* Effect.logWarning(
          `${describe} skipped-invalid-file: observed .credentials.json is invalid (${parsed.reason}).`,
        );
        return "skipped-invalid-file" as const;
      }

      // Plausibility belt: real session tokens expire within hours; a far-future expiresAt is a
      // sentinel (fabricated file), and persisting it would freeze out every real rotation after
      // it.
      if (
        parsed.metadata.expiresAt !== undefined &&
        !isPlausibleClaudeExpiry(parsed.metadata.expiresAt)
      ) {
        yield* Effect.logWarning(
          `${describe} skipped-implausible-expiry: observed expiresAt is more than 30 days in the future — not a live session file.`,
        );
        return "skipped-implausible-expiry" as const;
      }

      const accounts = yield* ConnectedAccountRepo;

      // Re-read the CURRENT stored copy right before deciding — another observer may have
      // persisted a fresher session since this one was seeded.
      const account = yield* accounts.getById(input.connectedAccountId);

      if (account === undefined || account.archivedAt !== null) {
        yield* Effect.logWarning(
          `${describe} skipped-account-unavailable: the connected account is no longer available.`,
        );
        return "skipped-account-unavailable" as const;
      }

      // Shape check on the decrypted STORED payload: only session-file accounts own the file.
      const storedPlaintext = yield* input.credentialCipher.decrypt(account.encryptedPayload);
      const storedPayload = parseClaudeCredentialPayload(JSON.parse(storedPlaintext));

      if ("token" in storedPayload) {
        yield* Effect.logInfo(
          `${describe} skipped-not-session-file: the stored payload is a setup token, never silently converted.`,
        );
        return "skipped-not-session-file" as const;
      }

      // Freshness marker: the stored FILE's own expiresAt is authoritative; the metadata mirror
      // only fills in when the stored file carries none.
      const storedParsed = parseClaudeCredentialsJson(storedPayload.credentialsJson);
      const storedExpiresAt =
        (storedParsed.valid ? storedParsed.metadata.expiresAt : undefined) ??
        readStoredClaudeExpiresAt(account.metadata);

      // NEVER write when equal or older (rotated-session safety, mirrors the codex guard).
      if (
        !isNewerClaudeCredentials({ observedExpiresAt: parsed.metadata.expiresAt, storedExpiresAt })
      ) {
        yield* Effect.logInfo(
          `${describe} skipped-not-newer: observed expiresAt ${parsed.metadata.expiresAt ?? "none"} is not strictly newer than stored ${storedExpiresAt ?? "none"}.`,
        );
        return "skipped-not-newer" as const;
      }

      const plaintextPayload = JSON.stringify({
        credentialsJson: input.observedCredentialsJson,
      });
      const sealed = yield* input.credentialCipher.encrypt(plaintextPayload);

      yield* accounts.replacePayload({
        id: account.id,
        kind: "credentials-json",
        encryptedPayload: sealed.sealed,
        encryptionKeyId: sealed.keyId,
        payloadSha256: sha256Hex(plaintextPayload),
        metadata: { ...account.metadata, ...parsed.metadata },
      });

      yield* accounts.updateSyncState({ id: account.id, lastSyncedAt: new Date() });

      yield* Effect.logInfo(
        `${describe} synced: persisted rotated session file (expiresAt ${parsed.metadata.expiresAt ?? "none"}, previously ${storedExpiresAt ?? "none"}).`,
      );
      return "synced" as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${describe} failed: persisting the session file crashed.`, cause).pipe(
          Effect.as("failed" as const),
        ),
      ),
    );

    return outcome;
  },
);

export interface SyncBackClaudeCredentialsInput<R = never> {
  /** The launch blueprint (re-derived from the stored attempt snapshot; carries only refs). */
  readonly blueprint: NewWorkspace;
  /**
   * Connected-account ids that were injected as a FILE at THIS workspace's launch (from the
   * runtime instance row's `launchCredentialInjections`). Accounts not listed here — env-injected
   * setup tokens, or legacy rows recorded before the column existed — are never synced.
   */
  readonly launchFileInjectedAccountIds: readonly string[];
  /** Undefined when SEALANT_CREDENTIALS_KEY is not configured on the worker. */
  readonly credentialCipher: CredentialCipherService | undefined;
  /**
   * Reads the workspace's current `$HOME/.claude/.credentials.json` contents (e.g. an exec into
   * the container). May fail — the container can already be gone; that only warns.
   */
  readonly readCredentialsJson: () => Effect.Effect<string, unknown, R>;
}

const warn = (message: string, cause?: unknown): Effect.Effect<void> =>
  cause === undefined ? Effect.logWarning(message) : Effect.logWarning(message, cause);

/**
 * Best-effort persistence of a workspace's refreshed claude session credentials file after a run
 * completes or a workspace is stopped/reaped.
 *
 * No-ops silently only when the blueprint has no claude credentialRef at all (normal for
 * non-claude workspaces). Every other path logs one outcome line per account, so a skipped sync
 * is always visible in the worker logs. Beyond the launch gate, only stored-file-shape accounts
 * are touched (decided by decrypting the STORED payload, not the db `kind` column). Never fails:
 * every abnormal condition is reported as a log line so the surrounding job is unaffected.
 */
export const syncBackClaudeCredentials = Effect.fn("syncBackClaudeCredentials")(function* <
  R = never,
>(input: SyncBackClaudeCredentialsInput<R>) {
  const claudeAccountIds: string[] = [];

  for (const credentialRef of input.blueprint.runtime.credentialRefs) {
    if (credentialRef.provider !== "claude") {
      continue;
    }

    const connectedAccountId = parseConnectedAccountRef(credentialRef.ref);

    if (connectedAccountId === undefined) {
      yield* warn(
        `Claude credentials sync-back skipped for unparseable ref '${credentialRef.ref}'.`,
      );
      continue;
    }

    claudeAccountIds.push(connectedAccountId);
  }

  // No claude refs at all: the only silent exit (normal for non-claude workspaces).
  if (claudeAccountIds.length === 0) {
    return;
  }

  // Launch-shape gate BEFORE any container exec: only accounts file-injected at THIS workspace's
  // launch qualify — an env-injected workspace pays no exec and syncs nothing.
  const fileInjectedAccountIds: string[] = [];

  for (const connectedAccountId of claudeAccountIds) {
    if (input.launchFileInjectedAccountIds.includes(connectedAccountId)) {
      fileInjectedAccountIds.push(connectedAccountId);
      continue;
    }

    yield* Effect.logInfo(
      `Claude credentials (workspace sync-back): account ${connectedAccountId} skipped-not-file-injected: not recorded as file-injected at this workspace's launch.`,
    );
  }

  if (fileInjectedAccountIds.length === 0) {
    return;
  }

  if (input.credentialCipher === undefined) {
    for (const connectedAccountId of fileInjectedAccountIds) {
      yield* warn(
        `Claude credentials (workspace sync-back): account ${connectedAccountId} failed: SEALANT_CREDENTIALS_KEY is not configured on the worker.`,
      );
    }
    return;
  }

  const cipher = input.credentialCipher;

  const rawCredentialsJson = yield* input
    .readCredentialsJson()
    .pipe(
      Effect.catch((cause) =>
        warn(
          "Claude credentials sync-back: could not read $HOME/.claude/.credentials.json from the workspace (the container may already be gone).",
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );

  if (rawCredentialsJson === undefined || rawCredentialsJson.trim().length === 0) {
    for (const connectedAccountId of fileInjectedAccountIds) {
      yield* warn(
        `Claude credentials (workspace sync-back): account ${connectedAccountId} failed-read: workspace .credentials.json was unreadable or empty.`,
      );
    }
    return;
  }

  for (const connectedAccountId of fileInjectedAccountIds) {
    yield* persistClaudeCredentialsIfNewer({
      connectedAccountId,
      observedCredentialsJson: rawCredentialsJson,
      credentialCipher: cipher,
      source: "workspace sync-back",
    });
  }
});
