import {
  claudeApiKeyUnsupported,
  claudeCredentialsFile,
  githubHostsYml,
  loginClassOf,
  parseConnectedAccountRef,
  parseStoredCredential,
  planCredentialInjections,
  type CredentialCipherService,
  type CredentialInjection,
  type ProviderCredentialPayload,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  type ConnectedAccount,
  type WorkspaceLaunchCredentialInjection,
} from "@sealant/db";
import type { NewWorkspace, WorkspaceCredentialsHome } from "@sealant/validators";
import { Effect } from "effect";

import { workspaceBuildJobProcessingError, toWorkspaceBuildJobProcessingError } from "./errors.js";

/*
Connected-account credential resolution (design doc §6), sibling of
github-installation-auth-resolver.ts: blueprints carry only opaque `connected-account:<id>` refs;
just before launch the worker resolves each ref, decrypts the sealed payload, and expands it into
the injection plan the runtime adapter executes (env vars + in-container files). Any unusable ref
fails the launch LOUDLY — a workspace must never silently run without the auth it asked for.
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
  /**
   * Launch-time record of how each resolved account was injected (env vs file), persisted on the
   * runtime instance row so post-run sync-backs trust what THIS workspace was seeded with — not
   * the account's current payload shape, which a reconnect may have switched mid-run.
   */
  readonly launchCredentialInjections: readonly WorkspaceLaunchCredentialInjection[];
}

export interface ResolveCredentialInjectionsInput {
  readonly blueprint: NewWorkspace;
  /**
   * Undefined when SEALANT_CREDENTIALS_KEY is not configured on the worker. Launching a blueprint
   * that carries credentialRefs without a cipher is a deployment misconfiguration and fails the
   * job visibly (mirrors the gitHubSourceIntegration-unavailable path).
   */
  readonly credentialCipher: CredentialCipherService | undefined;
}

/** `$HOME/<file>` → `<home>/<file>`: where a launch with a `credentialsHome` writes a login. */
const HOME_PREFIX = "$HOME/";

const homeFile = (home: WorkspaceCredentialsHome, file: string, content: string) => ({
  kind: "file" as const,
  path: `${home.path}/${file}`,
  contentBase64: Buffer.from(content, "utf8").toString("base64"),
  mode: "600",
});

type LoginPlan =
  | { readonly kind: "planned"; readonly injections: readonly CredentialInjection[] }
  | { readonly kind: "unsupported"; readonly message: string };

/**
 * A launch's plan for one login. With a `credentialsHome` (docs/connected-accounts-design.md §6d)
 * every login is a file in that home, GitHub included (as the CLI's `hosts.yml`), and nothing rides
 * the environment.
 */
const planLogin = (
  credential: ProviderCredentialPayload,
  account: ConnectedAccount,
  home: WorkspaceCredentialsHome | undefined,
): LoginPlan => {
  const [provider, payload] = credential;
  switch (provider) {
    case "github": {
      if (home === undefined) {
        return { kind: "planned", injections: planCredentialInjections(provider, payload) };
      }
      const login = account.metadata?.["login"];
      const hostsYml = githubHostsYml(payload.token, typeof login === "string" ? login : undefined);
      return { kind: "planned", injections: [homeFile(home, ".config/gh/hosts.yml", hostsYml)] };
    }
    case "claude": {
      if ("apiKey" in payload) {
        return { kind: "unsupported", message: claudeApiKeyUnsupported(account.name) };
      }
      if (home === undefined) {
        return { kind: "planned", injections: planCredentialInjections(provider, payload) };
      }
      // A setup token too: the planner's variable would be everyone's in a shared executor.
      return {
        kind: "planned",
        injections: [homeFile(home, ".claude/.credentials.json", claudeCredentialsFile(payload))],
      };
    }
    case "codex": {
      const planned = planCredentialInjections(provider, payload);
      if (home === undefined) return { kind: "planned", injections: planned };
      return {
        kind: "planned",
        injections: planned.map((injection) => {
          if (injection.kind !== "file" || !injection.path.startsWith(HOME_PREFIX)) {
            throw new Error(
              `A ${provider} login planned outside $HOME cannot be written into a home.`,
            );
          }
          return { ...injection, path: `${home.path}/${injection.path.slice(HOME_PREFIX.length)}` };
        }),
      };
    }
  }
};

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

const isUsableAccount = (account: ConnectedAccount): boolean => {
  return account.archivedAt === null && account.status !== "archived";
};

/**
 * Resolve the blueprint's `runtime.credentialRefs` into the launch injection plan.
 *
 * Every ref must resolve to an active connected account: missing, archived, or invalid accounts
 * fail with a typed {@link WorkspaceBuildJobProcessingError} naming the provider + ref so the
 * failure is actionable. `last_used_at` is stamped best-effort (bookkeeping must never fail a
 * launch). Codex accounts are additionally surfaced for the post-run auth.json sync-back.
 */
export const resolveCredentialInjections = Effect.fn("resolveCredentialInjections")(function* (
  input: ResolveCredentialInjectionsInput,
) {
  const credentialRefs = input.blueprint.runtime.credentialRefs;

  if (credentialRefs.length === 0) {
    const empty: ResolvedCredentialInjections = {
      injections: [],
      codexAccounts: [],
      launchCredentialInjections: [],
    };
    return empty;
  }

  if (input.credentialCipher === undefined) {
    return yield* workspaceBuildJobProcessingError({
      errorCode: "credentials-key-unconfigured",
      message:
        "This workspace requests connected-account credentials, but SEALANT_CREDENTIALS_KEY is not configured on the worker, so they cannot be decrypted. Set SEALANT_CREDENTIALS_KEY (32 random bytes, base64) on the worker and retry.",
    });
  }

  const accounts = yield* ConnectedAccountRepo;
  const injections: CredentialInjection[] = [];
  const codexAccounts: ResolvedCodexAccount[] = [];
  const launchCredentialInjections: WorkspaceLaunchCredentialInjection[] = [];

  for (const credentialRef of credentialRefs) {
    const connectedAccountId = parseConnectedAccountRef(credentialRef.ref);

    if (connectedAccountId === undefined) {
      return yield* workspaceBuildJobProcessingError({
        errorCode: "connected-account-ref-invalid",
        message: `Workspace ${describeRef(credentialRef.provider, credentialRef.ref)} is not a valid connected-account ref.`,
      });
    }

    const account = yield* accounts
      .getById(connectedAccountId)
      .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));

    if (account === undefined || !isUsableAccount(account)) {
      return yield* workspaceBuildJobProcessingError({
        errorCode: "connected-account-unavailable",
        message: `Workspace ${describeRef(credentialRef.provider, credentialRef.ref)} does not resolve to an active connected account. Reconnect the account and launch again.`,
      });
    }

    if (account.provider !== credentialRef.provider) {
      return yield* workspaceBuildJobProcessingError({
        errorCode: "connected-account-provider-mismatch",
        message: `Workspace ${describeRef(credentialRef.provider, credentialRef.ref)} resolves to a '${account.provider}' account; the blueprint expected '${credentialRef.provider}'.`,
      });
    }

    if (account.status === "invalid") {
      return yield* workspaceBuildJobProcessingError({
        errorCode: "connected-account-invalid",
        message: `Workspace ${describeRef(credentialRef.provider, credentialRef.ref)} points at a credential that has been marked invalid. Reconnect the '${credentialRef.provider}' account and launch again.`,
      });
    }

    const plaintext = yield* input.credentialCipher
      .decrypt(account.encryptedPayload)
      .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));

    const credentialsHome = input.blueprint.runtime.credentialsHome;
    const { credential, plan } = yield* Effect.try({
      try: () => {
        const stored = parseStoredCredential(credentialRef.provider, plaintext);
        return { credential: stored, plan: planLogin(stored, account, credentialsHome) };
      },
      catch: (cause) =>
        workspaceBuildJobProcessingError({
          errorCode: "connected-account-payload-invalid",
          message: `Workspace ${describeRef(credentialRef.provider, credentialRef.ref)} decrypted to an unusable payload. Reconnect the account to store a fresh credential.`,
          cause,
        }),
    });
    if (plan.kind === "unsupported") {
      return yield* workspaceBuildJobProcessingError({
        errorCode: "connected-account-unsupported",
        message: plan.message,
      });
    }
    const planned = plan.injections;

    injections.push(...planned);
    const login = loginClassOf(...credential);
    const fileInjected = planned.some((injection) => injection.kind === "file");
    launchCredentialInjections.push({
      provider: credentialRef.provider,
      connectedAccountId: account.id,
      injection: fileInjected ? "file" : "env",
      // Every Claude/Codex FILE planCredentialInjections writes is a copy that cannot refresh.
      ...(fileInjected &&
      (credentialRef.provider === "claude" || credentialRef.provider === "codex")
        ? { copy: true }
        : {}),
      ...(credentialsHome === undefined ? {} : { home: credentialsHome.path }),
      ...(login === undefined ? {} : { login }),
    });

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

  const resolved: ResolvedCredentialInjections = {
    injections,
    codexAccounts,
    launchCredentialInjections,
  };
  return resolved;
});
