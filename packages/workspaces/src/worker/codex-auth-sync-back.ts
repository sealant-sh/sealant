import {
  parseCodexAuthJson,
  parseConnectedAccountRef,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import { ConnectedAccountRepo } from "@sealant/db";
import type { NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";

import { readStoredCodexLastRefresh } from "./connected-account-resolver.js";

/*
Codex auth.json sync-back (design doc §2 codex / §6). The official Codex CLI inside the workspace
refreshes its session and ROTATES the refresh token, mutating $HOME/.codex/auth.json. After a run
completes, the worker reads the file back and persists it — but ONLY when its `last_refresh` is
strictly newer than the stored copy's. Writing an equal-or-older copy back could clobber a fresher
rotation persisted by another run and permanently brick the credential.

Concurrency note: the safe model is one live copy per credential. Concurrent workspaces sharing a
codex account can still race refreshes against each other inside OpenAI's systems — v1 accepts
that and applies newest-wins persistence on our side; the comparison below only guards OUR stored
copy against regressions.

Everything here is best-effort: the run already completed, so a failed sync-back (container gone,
unreadable file, repo hiccup) degrades to a logged warning, never a job failure.
*/

/**
 * Newest-wins guard: persist the observed auth.json only when its `last_refresh` is strictly
 * newer than the stored one (or the stored copy has none). Unparseable or missing observed
 * timestamps never win — when in doubt, keep the stored copy.
 */
export const isNewerCodexAuthRefresh = (input: {
  readonly observedLastRefresh: string | undefined;
  readonly storedLastRefresh: string | undefined;
}): boolean => {
  if (input.observedLastRefresh === undefined) {
    return false;
  }

  const observed = Date.parse(input.observedLastRefresh);

  if (Number.isNaN(observed)) {
    return false;
  }

  if (input.storedLastRefresh === undefined) {
    return true;
  }

  const stored = Date.parse(input.storedLastRefresh);

  if (Number.isNaN(stored)) {
    // Stored value is unreadable; a valid observed timestamp is strictly better information.
    return true;
  }

  return observed > stored;
};

/** One-line outcome of a persist attempt; the reason string lands verbatim in the log line. */
export type CodexAuthPersistOutcome =
  | "synced"
  | "skipped-invalid-file"
  | "skipped-account-unavailable"
  | "skipped-not-newer"
  | "failed";

export interface PersistCodexAuthJsonIfNewerInput {
  readonly connectedAccountId: string;
  /** The observed (possibly CLI-rotated) auth.json contents. */
  readonly observedAuthJson: string;
  readonly credentialCipher: CredentialCipherService;
  /** Names the observation path in the outcome log line (e.g. "workspace sync-back"). */
  readonly source: string;
}

/**
 * The shared persist core, sibling of `persistClaudeCredentialsIfNewer`: decide whether an
 * observed auth.json may replace the stored copy (parse → newest-wins on `last_refresh`) and
 * write it if so. Used by the workspace sync-back and the inference engine's point-of-use
 * refresh. Never fails; every call logs exactly one outcome line and returns the outcome.
 */
export const persistCodexAuthJsonIfNewer = Effect.fn("persistCodexAuthJsonIfNewer")(function* (
  input: PersistCodexAuthJsonIfNewerInput,
) {
  const describe = `Codex auth.json (${input.source}): account ${input.connectedAccountId}`;

  const outcome: CodexAuthPersistOutcome = yield* Effect.gen(function* () {
    const parsed = parseCodexAuthJson(input.observedAuthJson);

    if (!parsed.valid) {
      yield* Effect.logWarning(
        `${describe} skipped-invalid-file: observed auth.json is invalid (${parsed.reason}).`,
      );
      return "skipped-invalid-file" as const;
    }

    const accounts = yield* ConnectedAccountRepo;

    // Re-read the CURRENT stored copy right before deciding — another observer may have synced a
    // fresher rotation since this one was captured.
    const account = yield* accounts.getById(input.connectedAccountId);

    if (account === undefined || account.archivedAt !== null) {
      yield* Effect.logWarning(
        `${describe} skipped-account-unavailable: the connected account is no longer available.`,
      );
      return "skipped-account-unavailable" as const;
    }

    const storedLastRefresh = readStoredCodexLastRefresh(account.metadata);
    const observedLastRefresh = parsed.metadata.lastRefresh;

    // NEVER write when equal or older (rotated-refresh-token safety, design doc §2 codex).
    if (!isNewerCodexAuthRefresh({ observedLastRefresh, storedLastRefresh })) {
      yield* Effect.logInfo(
        `${describe} skipped-not-newer: observed last_refresh ${observedLastRefresh ?? "none"} is not strictly newer than stored ${storedLastRefresh ?? "none"}.`,
      );
      return "skipped-not-newer" as const;
    }

    const plaintextPayload = JSON.stringify({ authJson: input.observedAuthJson });
    const sealed = yield* input.credentialCipher.encrypt(plaintextPayload);

    yield* accounts.replacePayload({
      id: account.id,
      encryptedPayload: sealed.sealed,
      encryptionKeyId: sealed.keyId,
      payloadSha256: sha256Hex(plaintextPayload),
      metadata: {
        ...account.metadata,
        ...(parsed.metadata.accountId === undefined
          ? {}
          : { accountId: parsed.metadata.accountId }),
        ...(parsed.metadata.authMode === undefined ? {} : { authMode: parsed.metadata.authMode }),
        ...(parsed.metadata.lastRefresh === undefined
          ? {}
          : { lastRefresh: parsed.metadata.lastRefresh }),
        ...(parsed.metadata.email === undefined ? {} : { email: parsed.metadata.email }),
      },
    });

    yield* accounts.updateSyncState({ id: account.id, lastSyncedAt: new Date() });

    yield* Effect.logInfo(
      `${describe} synced: persisted rotated auth.json (last_refresh ${observedLastRefresh ?? "none"}, previously ${storedLastRefresh ?? "none"}).`,
    );
    return "synced" as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${describe} failed: persisting the auth.json crashed.`, cause).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );

  return outcome;
});

export interface SyncBackCodexAuthJsonInput<R = never> {
  /** The launch blueprint (re-derived from the stored attempt snapshot; carries only refs). */
  readonly blueprint: NewWorkspace;
  /** Undefined when SEALANT_CREDENTIALS_KEY is not configured on the worker. */
  readonly credentialCipher: CredentialCipherService | undefined;
  /**
   * Reads the workspace's current `$HOME/.codex/auth.json` contents (e.g. an exec into the
   * container). May fail — the container can already be gone; that only warns.
   */
  readonly readAuthJson: () => Effect.Effect<string, unknown, R>;
}

const warn = (message: string, cause?: unknown): Effect.Effect<void> =>
  cause === undefined ? Effect.logWarning(message) : Effect.logWarning(message, cause);

/**
 * Best-effort persistence of a workspace's refreshed codex auth.json after a run completes.
 *
 * No-ops (fast) when the blueprint has no codex credentialRef. Never fails: every abnormal
 * condition is reported as a log warning so run completion is unaffected.
 */
export const syncBackCodexAuthJson = Effect.fn("syncBackCodexAuthJson")(function* <R = never>(
  input: SyncBackCodexAuthJsonInput<R>,
) {
  const codexRefs = input.blueprint.runtime.credentialRefs.filter(
    (credentialRef) => credentialRef.provider === "codex",
  );

  if (codexRefs.length === 0) {
    return;
  }

  if (input.credentialCipher === undefined) {
    yield* warn(
      "Codex auth sync-back skipped: SEALANT_CREDENTIALS_KEY is not configured on the worker.",
    );
    return;
  }

  const cipher = input.credentialCipher;

  const rawAuthJson = yield* input
    .readAuthJson()
    .pipe(
      Effect.catch((cause) =>
        warn(
          "Codex auth sync-back skipped: could not read $HOME/.codex/auth.json from the workspace (the container may already be gone).",
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );

  if (rawAuthJson === undefined || rawAuthJson.trim().length === 0) {
    return;
  }

  const parsed = parseCodexAuthJson(rawAuthJson);

  if (!parsed.valid) {
    yield* warn(`Codex auth sync-back skipped: workspace auth.json is invalid (${parsed.reason}).`);
    return;
  }

  for (const codexRef of codexRefs) {
    const connectedAccountId = parseConnectedAccountRef(codexRef.ref);

    if (connectedAccountId === undefined) {
      yield* warn(`Codex auth sync-back skipped for unparseable ref '${codexRef.ref}'.`);
      continue;
    }

    yield* persistCodexAuthJsonIfNewer({
      connectedAccountId,
      observedAuthJson: rawAuthJson,
      credentialCipher: cipher,
      source: "workspace sync-back",
    });
  }
});
