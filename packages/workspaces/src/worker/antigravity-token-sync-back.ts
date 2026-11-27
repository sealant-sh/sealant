import {
  antigravityTokenCanRefresh,
  isNewerAntigravityToken,
  isPlausibleAntigravityExpiry,
  parseAntigravityTokenJson,
  parseAntigravityTokenPayload,
  readStoredAntigravityExpiresAt,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import { ConnectedAccountRepo } from "@sealant/db";
import { Effect } from "effect";

/*
Antigravity OAuth token persistence core (sibling of claude-credentials-sync-back.ts and
codex-auth-sync-back.ts).

The store holds the only Google OAuth refresh token of an Antigravity login (§6a "One refresher").
The keep-fresh worker refreshes it via `agy models` against a private 0700 HOME and persists the
refreshed file through {@link persistAntigravityTokenIfNewer}: parse -> refresh-token presence ->
plausibility belt -> revision/newest-wins on `token.expiry`. Never fails; every call logs exactly
one outcome line.
*/

export {
  isNewerAntigravityToken,
  isPlausibleAntigravityExpiry,
  MAX_PLAUSIBLE_ANTIGRAVITY_EXPIRY_AHEAD_MS,
  readStoredAntigravityExpiresAt,
} from "@sealant/credentials";

/** One-line outcome of a persist attempt; the reason string lands verbatim in the log line. */
export type AntigravityTokenPersistOutcome =
  | "synced"
  | "skipped-invalid-file"
  | "skipped-copy"
  | "skipped-implausible-expiry"
  | "skipped-account-unavailable"
  | "skipped-not-newer"
  | "skipped-superseded"
  | "failed";

export interface PersistAntigravityTokenIfNewerInput {
  readonly connectedAccountId: string;
  /** The observed (possibly CLI-refreshed) antigravity-oauth-token JSON contents. */
  readonly observedTokenJson: string;
  readonly credentialCipher: CredentialCipherService;
  /** Names the observation path in the outcome log line (e.g. "keep-fresh sweeper"). */
  readonly source: string;
  /** The credential revision the observed file was read from. */
  readonly sourceRevision: number | "unknown";
}

export const persistAntigravityTokenIfNewer = Effect.fn("sealant.credential.save_refreshed_login", {
  attributes: { "sealant.credential.provider": "antigravity" },
})(function* (input: PersistAntigravityTokenIfNewerInput) {
  const describe = `Antigravity token (${input.source}): account ${input.connectedAccountId}`;

  const outcome: AntigravityTokenPersistOutcome = yield* Effect.gen(function* () {
    const parsed = parseAntigravityTokenJson(input.observedTokenJson);

    if (!parsed.valid) {
      yield* Effect.logWarning(
        `${describe} skipped-invalid-file: observed antigravity-oauth-token is invalid (${parsed.reason}).`,
      );
      return "skipped-invalid-file" as const;
    }

    // A copy (no refresh_token) never replaces the store's login (§6a "One refresher").
    if (!antigravityTokenCanRefresh(input.observedTokenJson)) {
      yield* Effect.logWarning(
        `${describe} skipped-copy: the observed file has no refresh_token — a copy, not the login.`,
      );
      return "skipped-copy" as const;
    }

    if (
      parsed.metadata.expiresAt !== undefined &&
      !isPlausibleAntigravityExpiry(parsed.metadata.expiresAt)
    ) {
      yield* Effect.logWarning(
        `${describe} skipped-implausible-expiry: observed token.expiry is more than 30 days in the future — not a live OAuth token.`,
      );
      return "skipped-implausible-expiry" as const;
    }

    const accounts = yield* ConnectedAccountRepo;
    const account = yield* accounts.getById(input.connectedAccountId);

    if (account === undefined || account.archivedAt !== null) {
      yield* Effect.logWarning(
        `${describe} skipped-account-unavailable: the connected account is no longer available.`,
      );
      return "skipped-account-unavailable" as const;
    }

    if (input.sourceRevision !== "unknown" && account.credentialRevision !== input.sourceRevision) {
      yield* Effect.logInfo(
        `${describe} skipped-superseded: the observed file came from credential revision ${input.sourceRevision}; the account now holds revision ${account.credentialRevision}.`,
      );
      return "skipped-superseded" as const;
    }

    const storedPlaintext = yield* input.credentialCipher.decrypt(account.encryptedPayload);
    const storedPayload = parseAntigravityTokenPayload(JSON.parse(storedPlaintext));
    const storedParsed = parseAntigravityTokenJson(storedPayload.tokenJson);
    const storedExpiresAt =
      (storedParsed.valid ? storedParsed.metadata.expiresAt : undefined) ??
      readStoredAntigravityExpiresAt(account.metadata);

    if (
      !isNewerAntigravityToken({
        observedExpiresAt: parsed.metadata.expiresAt,
        storedExpiresAt,
      })
    ) {
      yield* Effect.logInfo(
        `${describe} skipped-not-newer: observed expiresAt ${parsed.metadata.expiresAt ?? "none"} is not strictly newer than stored ${storedExpiresAt ?? "none"}.`,
      );
      return "skipped-not-newer" as const;
    }

    const plaintextPayload = JSON.stringify({ tokenJson: input.observedTokenJson });
    const sealed = yield* input.credentialCipher.encrypt(plaintextPayload);

    const replaced = yield* accounts.replacePayload({
      id: account.id,
      expectedRevision: account.credentialRevision,
      kind: "antigravity-token",
      encryptedPayload: sealed.sealed,
      encryptionKeyId: sealed.keyId,
      payloadSha256: sha256Hex(plaintextPayload),
      metadata: { ...account.metadata, ...parsed.metadata },
    });

    if (replaced === undefined) {
      yield* Effect.logInfo(
        `${describe} skipped-superseded: the stored credential changed while this one was being decided on.`,
      );
      return "skipped-superseded" as const;
    }

    yield* accounts.updateSyncState({ id: account.id, lastSyncedAt: new Date() });

    yield* Effect.logInfo(
      `${describe} synced: persisted refreshed OAuth token (expiresAt ${parsed.metadata.expiresAt ?? "none"}, previously ${storedExpiresAt ?? "none"}).`,
    );
    return "synced" as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${describe} failed: persisting the OAuth token crashed.`, cause).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );

  return outcome;
});
