import {
  parseClaudeCredentialPayload,
  parseClaudeCredentialsJson,
  parseConnectedAccountRef,
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
run completes, the worker reads the file back and persists it — but ONLY when its
`claudeAiOauth.expiresAt` is strictly newer than the stored copy's (newest-wins; an equal-or-older
copy could clobber a fresher rotation persisted by another run). Setup-token claude accounts are
skipped entirely: they are injected as an env var, own no file, and must never be silently
converted by a file the harness happens to write.

Everything here is best-effort: the run already completed, so a failed sync-back (container gone,
unreadable file, repo hiccup) degrades to a logged warning, never a job failure.
*/

/**
 * Newest-wins guard on `claudeAiOauth.expiresAt` (epoch millis): persist the observed file only
 * when its expiry is strictly later than the stored one (or the stored copy has none). A missing
 * observed expiry never wins — when in doubt, keep the stored copy.
 */
export const isNewerClaudeCredentials = (input: {
  readonly observedExpiresAt: number | undefined;
  readonly storedExpiresAt: number | undefined;
}): boolean => {
  if (input.observedExpiresAt === undefined) {
    return false;
  }

  if (input.storedExpiresAt === undefined) {
    return true;
  }

  return input.observedExpiresAt > input.storedExpiresAt;
};

/** Read `metadata.expiresAt` defensively — metadata is a free-form Record<string, unknown>. */
export const readStoredClaudeExpiresAt = (
  metadata: Record<string, unknown> | null | undefined,
): number | undefined => {
  const expiresAt = metadata?.expiresAt;

  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
};

export interface SyncBackClaudeCredentialsInput<R = never> {
  /** The launch blueprint (re-derived from the stored attempt snapshot; carries only refs). */
  readonly blueprint: NewWorkspace;
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
 * completes.
 *
 * No-ops (fast) when the blueprint has no claude credentialRef. Only file-kind accounts are
 * touched, and that is decided by decrypting the STORED payload and dispatching on its shape (not
 * the db `kind` column). Never fails: every abnormal condition is reported as a log warning so run
 * completion is unaffected.
 */
export const syncBackClaudeCredentials = Effect.fn("syncBackClaudeCredentials")(function* <
  R = never,
>(input: SyncBackClaudeCredentialsInput<R>) {
  const claudeRefs = input.blueprint.runtime.credentialRefs.filter(
    (credentialRef) => credentialRef.provider === "claude",
  );

  if (claudeRefs.length === 0) {
    return;
  }

  if (input.credentialCipher === undefined) {
    yield* warn(
      "Claude credentials sync-back skipped: SEALANT_CREDENTIALS_KEY is not configured on the worker.",
    );
    return;
  }

  const cipher = input.credentialCipher;

  const rawCredentialsJson = yield* input
    .readCredentialsJson()
    .pipe(
      Effect.catch((cause) =>
        warn(
          "Claude credentials sync-back skipped: could not read $HOME/.claude/.credentials.json from the workspace (the container may already be gone).",
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );

  if (rawCredentialsJson === undefined || rawCredentialsJson.trim().length === 0) {
    return;
  }

  const parsed = parseClaudeCredentialsJson(rawCredentialsJson);

  if (!parsed.valid) {
    yield* warn(
      `Claude credentials sync-back skipped: workspace .credentials.json is invalid (${parsed.reason}).`,
    );
    return;
  }

  const accounts = yield* ConnectedAccountRepo;

  for (const claudeRef of claudeRefs) {
    const connectedAccountId = parseConnectedAccountRef(claudeRef.ref);

    if (connectedAccountId === undefined) {
      yield* warn(`Claude credentials sync-back skipped for unparseable ref '${claudeRef.ref}'.`);
      continue;
    }

    const syncOne = Effect.gen(function* () {
      // Re-read the CURRENT stored copy right before deciding — another run may have synced a
      // fresher session since this workspace launched.
      const account = yield* accounts.getById(connectedAccountId);

      if (account === undefined || account.archivedAt !== null) {
        yield* warn(
          `Claude credentials sync-back skipped: connected account ${connectedAccountId} is no longer available.`,
        );
        return;
      }

      // Shape check on the decrypted STORED payload: only session-file accounts own the file.
      const storedPlaintext = yield* cipher.decrypt(account.encryptedPayload);
      const storedPayload = parseClaudeCredentialPayload(JSON.parse(storedPlaintext));

      if ("token" in storedPayload) {
        return;
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
        return;
      }

      const plaintextPayload = JSON.stringify({ credentialsJson: rawCredentialsJson });
      const sealed = yield* cipher.encrypt(plaintextPayload);

      yield* accounts.replacePayload({
        id: account.id,
        kind: "credentials-json",
        encryptedPayload: sealed.sealed,
        encryptionKeyId: sealed.keyId,
        payloadSha256: sha256Hex(plaintextPayload),
        metadata: { ...account.metadata, ...parsed.metadata },
      });

      yield* accounts.updateSyncState({ id: account.id, lastSyncedAt: new Date() });
    });

    yield* syncOne.pipe(
      Effect.catchCause((cause) =>
        warn(
          `Claude credentials sync-back failed for connected account ${connectedAccountId}; continuing.`,
          cause,
        ),
      ),
    );
  }
});
