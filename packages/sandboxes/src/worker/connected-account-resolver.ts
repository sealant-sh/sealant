import {
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  parseConnectedAccountRef,
  parseGitHubCredentialPayload,
  planCredentialInjections,
  type CredentialCipherService,
  type CredentialInjection,
} from "@sealant/credentials";
import { ConnectedAccountRepo, type ConnectedAccount } from "@sealant/db";
import type { NewSandbox } from "@sealant/validators";
import { Effect } from "effect";

import { sandboxBuildJobProcessingError, toSandboxBuildJobProcessingError } from "./errors.js";

/*
Connected-account credential resolution (design doc §6), sibling of
github-installation-auth-resolver.ts: blueprints carry only opaque `connected-account:<id>` refs;
just before launch the worker resolves each ref, decrypts the sealed payload, and expands it into
the injection plan the runtime adapter executes (env vars + in-container files). Any unusable ref
fails the launch LOUDLY — a sandbox must never silently run without the auth it asked for.
*/

/** Non-secret bookkeeping the codex sync-back needs after runs complete (design doc §2 codex). */
export interface ResolvedCodexAccount {
  readonly connectedAccountId: string;
  /** `metadata.lastRefresh` as stored at launch time; undefined when never recorded. */
  readonly storedLastRefresh: string | undefined;
}

export interface ResolvedCredentialInjections {
  readonly injections: readonly CredentialInjection[];
  readonly codexAccounts: readonly ResolvedCodexAccount[];
}

export interface ResolveCredentialInjectionsInput {
  readonly blueprint: NewSandbox;
  /**
   * Undefined when SEALANT_CREDENTIALS_KEY is not configured on the worker. Launching a blueprint
   * that carries credentialRefs without a cipher is a deployment misconfiguration and fails the
   * job visibly (mirrors the gitHubSourceIntegration-unavailable path).
   */
  readonly credentialCipher: CredentialCipherService | undefined;
}

/** Read `metadata.lastRefresh` defensively — metadata is a free-form Record<string, unknown>. */
export const readStoredCodexLastRefresh = (
  metadata: Record<string, unknown> | null | undefined,
): string | undefined => {
  const lastRefresh = metadata?.lastRefresh;

  return typeof lastRefresh === "string" && lastRefresh.length > 0 ? lastRefresh : undefined;
};

const describeRef = (provider: string, ref: string): string => {
  return `connected account ref '${ref}' (provider '${provider}')`;
};

const parseProviderPayload = (
  provider: "claude" | "codex" | "github",
  plaintext: string,
): readonly CredentialInjection[] => {
  const parsed: unknown = JSON.parse(plaintext);

  switch (provider) {
    case "claude": {
      return planCredentialInjections(provider, parseClaudeCredentialPayload(parsed));
    }
    case "codex": {
      return planCredentialInjections(provider, parseCodexCredentialPayload(parsed));
    }
    case "github": {
      return planCredentialInjections(provider, parseGitHubCredentialPayload(parsed));
    }
  }
};

const isUsableAccount = (account: ConnectedAccount): boolean => {
  return account.archivedAt === null && account.status !== "archived";
};

/**
 * Resolve the blueprint's `runtime.credentialRefs` into the launch injection plan.
 *
 * Every ref must resolve to an active connected account: missing, archived, or invalid accounts
 * fail with a typed {@link SandboxBuildJobProcessingError} naming the provider + ref so the
 * failure is actionable. `last_used_at` is stamped best-effort (bookkeeping must never fail a
 * launch). Codex accounts are additionally surfaced for the post-run auth.json sync-back.
 */
export const resolveCredentialInjections = Effect.fn("resolveCredentialInjections")(function* (
  input: ResolveCredentialInjectionsInput,
) {
  const credentialRefs = input.blueprint.runtime.credentialRefs;

  if (credentialRefs.length === 0) {
    const empty: ResolvedCredentialInjections = { injections: [], codexAccounts: [] };
    return empty;
  }

  if (input.credentialCipher === undefined) {
    return yield* sandboxBuildJobProcessingError({
      errorCode: "credentials-key-unconfigured",
      message:
        "This sandbox requests connected-account credentials, but SEALANT_CREDENTIALS_KEY is not configured on the worker, so they cannot be decrypted. Set SEALANT_CREDENTIALS_KEY (32 random bytes, base64) on the worker and retry.",
    });
  }

  const accounts = yield* ConnectedAccountRepo;
  const injections: CredentialInjection[] = [];
  const codexAccounts: ResolvedCodexAccount[] = [];

  for (const credentialRef of credentialRefs) {
    const connectedAccountId = parseConnectedAccountRef(credentialRef.ref);

    if (connectedAccountId === undefined) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "connected-account-ref-invalid",
        message: `Sandbox ${describeRef(credentialRef.provider, credentialRef.ref)} is not a valid connected-account ref.`,
      });
    }

    const account = yield* accounts
      .getById(connectedAccountId)
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

    if (account === undefined || !isUsableAccount(account)) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "connected-account-unavailable",
        message: `Sandbox ${describeRef(credentialRef.provider, credentialRef.ref)} does not resolve to an active connected account. Reconnect the account and launch again.`,
      });
    }

    if (account.provider !== credentialRef.provider) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "connected-account-provider-mismatch",
        message: `Sandbox ${describeRef(credentialRef.provider, credentialRef.ref)} resolves to a '${account.provider}' account; the blueprint expected '${credentialRef.provider}'.`,
      });
    }

    if (account.status === "invalid") {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "connected-account-invalid",
        message: `Sandbox ${describeRef(credentialRef.provider, credentialRef.ref)} points at a credential that has been marked invalid. Reconnect the '${credentialRef.provider}' account and launch again.`,
      });
    }

    const plaintext = yield* input.credentialCipher
      .decrypt(account.encryptedPayload)
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

    const planned = yield* Effect.try({
      try: () => parseProviderPayload(credentialRef.provider, plaintext),
      catch: (cause) =>
        sandboxBuildJobProcessingError({
          errorCode: "connected-account-payload-invalid",
          message: `Sandbox ${describeRef(credentialRef.provider, credentialRef.ref)} decrypted to an unusable payload. Reconnect the account to store a fresh credential.`,
          cause,
        }),
    });

    injections.push(...planned);

    if (credentialRef.provider === "codex") {
      codexAccounts.push({
        connectedAccountId: account.id,
        storedLastRefresh: readStoredCodexLastRefresh(account.metadata),
      });
    }

    // Best-effort usage stamp: bookkeeping must never fail a launch.
    yield* accounts.updateSyncState({ id: account.id, lastUsedAt: new Date() }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to stamp last_used_at for connected account ${account.id}; continuing.`,
          cause,
        ),
      ),
      Effect.asVoid,
    );
  }

  const resolved: ResolvedCredentialInjections = { injections, codexAccounts };
  return resolved;
});
