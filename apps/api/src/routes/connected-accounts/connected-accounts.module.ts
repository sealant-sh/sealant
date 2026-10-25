import { randomUUID } from "node:crypto";

import {
  ConnectedAccountBadRequestError,
  ConnectedAccountConflictError,
  ConnectedAccountInternalServerError,
  ConnectedAccountNotFoundError,
  ConnectedAccountServiceUnavailableError,
  DEFAULT_ACCOUNT_SELECTOR,
  type ConnectedAccountCredential,
  type ConnectedAccountLogin,
  type ConnectedAccountLoginClass,
  type ConnectedAccountSummary,
  type CreateConnectedAccountRequest,
  type ListConnectedAccountsResponse,
  type MarkConnectedAccountInvalidResponse,
} from "@sealant/api-contracts";
import {
  apiKeyMetadata,
  CLAUDE_ADMIN_KEY_PREFIX,
  CLAUDE_API_KEY_PREFIX,
  CLAUDE_TOKEN_PREFIX,
  codexAuthJsonLogin,
  CredentialCipher,
  credentialKindOf,
  loginClassOf,
  loginClassOfKind,
  narrowClaudeCredentialsJson,
  OPENAI_API_KEY_PREFIX,
  parseApiKey,
  parseClaudeCredentialsJson,
  parseCodexAuthJson,
  parseConnectedAccountKind,
  parseStoredCredential,
  sha256Hex,
  type ConnectedAccountKind,
  type ConnectedAccountProvider,
  type CredentialCipherService,
  type ProviderCredentialPayload,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoInvariantError,
  ConnectedAccountRepoUnexpectedError,
  type ConnectedAccount,
  type ConnectedAccountWithDefault,
} from "@sealant/db";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";

/*
Connected provider accounts. Same trust model as ssh-keys: the internal API trusts the
caller-supplied owner; the web tRPC proxy and the CLI inject the session/configured user.
The secret arrives as provider-shaped plaintext, is validated/normalized per provider, sealed
with the credential cipher, and stored — no endpoint ever returns it.
*/

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new ConnectedAccountInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

/**
 * Every connected-accounts entry point is gated on this check, so the zero-key fallback cipher
 * layer wired in `index.ts` is never exercised when the feature is unconfigured.
 */
const requireCredentialsKey = Effect.gen(function* () {
  const key = env.SEALANT_CREDENTIALS_KEY?.trim();

  if (key === undefined || key.length === 0) {
    return yield* new ConnectedAccountServiceUnavailableError({
      message: "Connected accounts require SEALANT_CREDENTIALS_KEY to be configured.",
    });
  }
});

/** Epoch millis from the non-secret metadata mirror, or null when nothing was stored. */
const storedInstant = (metadata: Record<string, unknown>, key: string): string | null => {
  const value = metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/**
 * Freshness as this control plane observed it. Everything here is already in the metadata mirror
 * or a column: the payload stays sealed, and a consumer gets an observation instead of a guess
 * (Mend's ADR 0005 asked for exactly this).
 */
const toCredentialFreshness = (account: ConnectedAccount): ConnectedAccountCredential => {
  const outcome = account.metadata["lastRefreshOutcome"];
  const lastRefreshOutcome: ConnectedAccountCredential["lastRefreshOutcome"] =
    outcome === "refreshed" || outcome === "fresh" || outcome === "failed" ? outcome : null;
  return {
    accessExpiresAt: storedInstant(account.metadata, "expiresAt"),
    refreshExpiresAt: storedInstant(account.metadata, "refreshTokenExpiresAt"),
    // The sweeper and the sync-back both stamp lastSyncedAt when they touch a credential.
    lastRefreshAt: account.lastSyncedAt?.toISOString() ?? null,
    lastRefreshOutcome,
  };
};

/** A summary reads the stored `kind`; the Codex conversion corrects it on rows from before keys. */
const toConnectedAccountLogin = (account: ConnectedAccount): ConnectedAccountLogin | undefined => {
  const kind = parseConnectedAccountKind(account.kind);
  const login = kind === undefined ? undefined : loginClassOfKind(kind);
  if (login !== "api-key") return login === undefined ? undefined : { kind: login };
  const suffix = account.metadata["tokenSuffix"];
  return typeof suffix === "string" && suffix.length > 0 ? { kind: "api-key", suffix } : undefined;
};

export const toConnectedAccountSummary = (
  account: ConnectedAccountWithDefault,
): ConnectedAccountSummary => {
  const login = toConnectedAccountLogin(account);
  return {
    connectedAccountId: account.id,
    ownerUserId: account.ownerUserId,
    provider: account.provider,
    name: account.name,
    kind: account.kind,
    status: account.status,
    metadata: account.metadata,
    // createdAt doubles as the design doc's connected_at (set at connect; payload replacement
    // bumps updatedAt).
    connectedAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    credential: toCredentialFreshness(account),
    isDefault: account.isDefault,
    credentialRevision: account.credentialRevision,
    ...(login === undefined ? {} : { login }),
  };
};

interface NormalizedCredential {
  readonly kind: ConnectedAccountKind;
  readonly login: ConnectedAccountLoginClass | undefined;
  /** JSON payload string that gets sealed — the only place secret material lives. */
  readonly payloadJson: string;
  /** NON-secret display/ops data persisted in the metadata column. */
  readonly metadata: Record<string, unknown>;
}

const credentialOf = (
  credential: ProviderCredentialPayload,
  metadata: Record<string, unknown>,
): NormalizedCredential => ({
  kind: credentialKindOf(...credential),
  login: loginClassOf(...credential),
  payloadJson: JSON.stringify(credential[1]),
  metadata,
});

const apiKeyCredential = (provider: "claude" | "codex", apiKey: string): NormalizedCredential =>
  credentialOf(provider === "claude" ? ["claude", { apiKey }] : ["codex", { apiKey }], {
    ...apiKeyMetadata({ apiKey }),
    connectedVia: "paste",
  });

type GitHubTokenVerification =
  | { readonly outcome: "verified"; readonly login?: string; readonly scopes: readonly string[] }
  | { readonly outcome: "unverified" }
  | { readonly outcome: "rejected" };

const readLogin = (body: unknown): string | undefined => {
  if (typeof body === "object" && body !== null && "login" in body) {
    const login = (body as { readonly login: unknown }).login;

    return typeof login === "string" && login.length > 0 ? login : undefined;
  }

  return undefined;
};

/**
 * Best-effort live verification against api.github.com. A definitive 401/403 rejects the token;
 * network failures (offline/air-gapped deployments) accept it unverified rather than blocking
 * the connect.
 */
const verifyGitHubToken = (token: string): Effect.Effect<GitHubTokenVerification> => {
  return Effect.tryPromise({
    try: async (): Promise<GitHubTokenVerification> => {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "sealant-control-plane",
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (response.status === 401 || response.status === 403) {
        return { outcome: "rejected" };
      }

      if (!response.ok) {
        return { outcome: "unverified" };
      }

      const scopes = (response.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);

      let login: string | undefined;

      try {
        login = readLogin(await response.json());
      } catch {
        // The scopes header already verified the token; a malformed body only loses the login.
      }

      return { outcome: "verified", ...(login === undefined ? {} : { login }), scopes };
    },
    catch: (error) => error,
  }).pipe(
    // fetch rejected (DNS failure, timeout, no outbound network): accept unverified.
    Effect.catch(() => Effect.succeed<GitHubTokenVerification>({ outcome: "unverified" })),
  );
};

/**
 * Validate and shape a pasted credential for storage. Exported for tests: what this returns is
 * what gets sealed, so the narrowing below is worth pinning without a route.
 */
export const normalizeSecret = (
  provider: ConnectedAccountProvider,
  secret: string,
): Effect.Effect<NormalizedCredential, ConnectedAccountBadRequestError> => {
  return Effect.gen(function* () {
    switch (provider) {
      case "claude": {
        const token = secret.trim();

        // A pasted JSON object is a full Claude Code session credentials file (the contents of a
        // .credentials.json the operator minted for Sealant); anything else must be a setup-token.
        if (token.startsWith("{")) {
          const parsed = parseClaudeCredentialsJson(secret);

          if (!parsed.valid) {
            return yield* new ConnectedAccountBadRequestError({ message: parsed.reason });
          }

          // Narrowed to the grant: a .credentials.json also carries `mcpOAuth`, refresh tokens
          // for the MCP servers the person authorized on their own machine. Those belong there,
          // not in this database and not in every workspace that attaches the account. A client
          // that narrows before sending (Mend does) sees no change here; one that does not is
          // still stored narrow.
          const narrowed = narrowClaudeCredentialsJson(secret);

          return credentialOf(["claude", { credentialsJson: narrowed.credentialsJson }], {
            ...parsed.metadata,
            connectedVia: "paste",
            ...(narrowed.dropped.length === 0 ? {} : { droppedSections: [...narrowed.dropped] }),
          });
        }

        if (token.startsWith(CLAUDE_API_KEY_PREFIX) || token.startsWith(CLAUDE_ADMIN_KEY_PREFIX)) {
          const key = parseApiKey("claude", token);
          if (!key.valid) {
            return yield* new ConnectedAccountBadRequestError({ message: key.reason });
          }
          return apiKeyCredential("claude", key.apiKey);
        }

        if (!token.startsWith(CLAUDE_TOKEN_PREFIX)) {
          return yield* new ConnectedAccountBadRequestError({
            message: `Claude credential must be a \`claude setup-token\` value (starts with "${CLAUDE_TOKEN_PREFIX}"), an Anthropic API key (starts with "${CLAUDE_API_KEY_PREFIX}"), or the JSON contents of a Claude Code .credentials.json session file.`,
          });
        }

        return credentialOf(["claude", { token }], {
          tokenSuffix: token.slice(-4),
          connectedVia: "paste",
        });
      }
      case "codex": {
        const trimmed = secret.trim();

        if (!trimmed.startsWith("{")) {
          if (!trimmed.startsWith(OPENAI_API_KEY_PREFIX)) {
            return yield* new ConnectedAccountBadRequestError({
              message: `Codex credential must be the JSON contents of ~/.codex/auth.json or an OpenAI API key (starts with "${OPENAI_API_KEY_PREFIX}").`,
            });
          }
          const key = parseApiKey("codex", trimmed);
          if (!key.valid) {
            return yield* new ConnectedAccountBadRequestError({ message: key.reason });
          }
          return apiKeyCredential("codex", key.apiKey);
        }

        const parsed = parseCodexAuthJson(secret);

        if (!parsed.valid) {
          return yield* new ConnectedAccountBadRequestError({ message: parsed.reason });
        }

        const login = codexAuthJsonLogin(secret);
        if (login?.login === "api-key") {
          if (!login.key.valid) {
            return yield* new ConnectedAccountBadRequestError({ message: login.key.reason });
          }
          return apiKeyCredential("codex", login.key.apiKey);
        }

        // Stored verbatim so the exact file can be re-materialized in the workspace.
        return credentialOf(["codex", { authJson: secret }], { ...parsed.metadata });
      }
      case "github": {
        const token = secret.trim();
        const verification = yield* verifyGitHubToken(token);

        if (verification.outcome === "rejected") {
          return yield* new ConnectedAccountBadRequestError({
            message: "GitHub rejected this token. Run `gh auth token` and paste a current one.",
          });
        }

        return credentialOf(
          ["github", { token }],
          verification.outcome === "verified"
            ? {
                ...(verification.login === undefined ? {} : { login: verification.login }),
                scopes: verification.scopes,
                tokenType: "gh-cli",
                scopesVerified: true,
              }
            : { tokenType: "gh-cli", scopesVerified: false },
        );
      }
    }
  });
};

type ConnectRequestTarget =
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "none" };

const parseConnectRequestTarget = (
  request: CreateConnectedAccountRequest,
): Effect.Effect<ConnectRequestTarget, ConnectedAccountBadRequestError> => {
  if (request.accountId !== undefined) {
    return request.name === undefined
      ? Effect.succeed({ kind: "account", accountId: request.accountId })
      : Effect.fail(
          new ConnectedAccountBadRequestError({
            message: "Name the account to connect or give its accountId, not both.",
          }),
        );
  }
  return Effect.succeed(
    request.name === undefined ? { kind: "none" } : { kind: "name", name: request.name },
  );
};

type ConnectTarget =
  | { readonly kind: "replace"; readonly account: ConnectedAccountWithDefault }
  | { readonly kind: "create"; readonly name: string };

const providerLabel = { claude: "Claude", codex: "Codex", github: "GitHub" } as const;
const loginLabel = { subscription: "subscription login", "api-key": "API key" } as const;

type StoredLogin = ConnectedAccountLoginClass | "unreadable" | undefined;

const storedLoginOf = (
  cipher: CredentialCipherService,
  account: ConnectedAccount,
): Effect.Effect<StoredLogin> =>
  cipher.decrypt(account.encryptedPayload).pipe(
    Effect.flatMap((plaintext) =>
      Effect.try(() => loginClassOf(...parseStoredCredential(account.provider, plaintext))),
    ),
    Effect.orElseSucceed((): StoredLogin => "unreadable"),
  );

const freeName = (base: string, existing: readonly ConnectedAccountWithDefault[]): string => {
  const taken = new Set(existing.map((account) => account.name));
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}-${String(suffix)}`;
  return name;
};

/**
 * Which account a connect writes. Without a target it is the only account of the secret's login
 * class, read from each stored payload (a row the Codex conversion has not reached yet included),
 * so a key never replaces a subscription; an account whose payload cannot be read is a candidate
 * of either class, so it is never passed over in silence.
 */
const connectTarget = (
  provider: ConnectedAccountProvider,
  requested: ConnectRequestTarget,
  existing: readonly ConnectedAccountWithDefault[],
  login: ConnectedAccountLoginClass | undefined,
  storedLogins: ReadonlyMap<string, StoredLogin>,
): Effect.Effect<ConnectTarget, ConnectedAccountNotFoundError | ConnectedAccountConflictError> => {
  if (requested.kind === "account") {
    const account = existing.find((candidate) => candidate.id === requested.accountId);
    return account === undefined
      ? Effect.fail(
          new ConnectedAccountNotFoundError({
            message: `No ${provider} connected account ${requested.accountId} to replace.`,
          }),
        )
      : Effect.succeed({ kind: "replace", account });
  }
  if (existing.length === 0) {
    return Effect.succeed({ kind: "create", name: DEFAULT_ACCOUNT_SELECTOR });
  }
  if (requested.kind === "name") {
    const named =
      requested.name === DEFAULT_ACCOUNT_SELECTOR
        ? existing.find((candidate) => candidate.isDefault)
        : existing.find((candidate) => candidate.name === requested.name);
    if (named !== undefined) {
      return Effect.succeed({ kind: "replace", account: named });
    }
    if (requested.name !== DEFAULT_ACCOUNT_SELECTOR) {
      return Effect.succeed({ kind: "create", name: requested.name });
    }
  }
  const candidates =
    login === undefined
      ? existing
      : existing.filter((candidate) => {
          const stored = storedLogins.get(candidate.id);
          return stored === login || stored === "unreadable";
        });
  const [only, ...others] = candidates;
  if (only !== undefined && others.length === 0) {
    return Effect.succeed({ kind: "replace", account: only });
  }
  if (only === undefined && login !== undefined) {
    return Effect.succeed({ kind: "create", name: freeName(login, existing) });
  }
  return Effect.fail(
    new ConnectedAccountConflictError({
      message: `Several ${login === undefined ? provider : `${providerLabel[provider]} ${loginLabel[login]}`} accounts are connected; say which one to replace with accountId, or name a new one.`,
      code: "connected-account-ambiguous",
      candidateAccountIds: candidates.map((account) => account.id),
    }),
  );
};

const loginMismatch = (
  provider: "claude" | "codex",
  expected: ConnectedAccountLoginClass,
  actual: ConnectedAccountLoginClass,
): string =>
  `That is a ${providerLabel[provider]} ${loginLabel[actual]}, not ${expected === "api-key" ? "an" : "a"} ${loginLabel[expected]}.`;

const withOwnerLock = <A, E, R>(ownerUserId: string, write: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;
    return yield* connectedAccountRepo
      .withOwnerLock(ownerUserId, write)
      .pipe(
        Effect.mapError((error) =>
          error instanceof ConnectedAccountRepoInvariantError ||
          error instanceof ConnectedAccountRepoUnexpectedError
            ? new ConnectedAccountInternalServerError({ message: error.message })
            : error,
        ),
      );
  });

const reloadAccount = (id: string) =>
  Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;
    const account = yield* withInternalError(
      connectedAccountRepo.getById(id),
      "Failed to load connected account.",
    );
    if (account === undefined) {
      return yield* new ConnectedAccountInternalServerError({
        message: `Connected account ${id} disappeared while it was written.`,
      });
    }
    return account;
  });

export const createConnectedAccount = (input: {
  readonly payload: CreateConnectedAccountRequest;
}) => {
  return Effect.gen(function* () {
    yield* requireCredentialsKey;
    const request = input.payload;
    const requested = yield* parseConnectRequestTarget(request);

    if (request.provider === "github" && request.login !== undefined) {
      return yield* new ConnectedAccountBadRequestError({
        message:
          "A GitHub token is neither a subscription login nor an API key; connect it without login.",
      });
    }

    const normalized = yield* normalizeSecret(request.provider, request.secret);
    if (
      request.provider !== "github" &&
      request.login !== undefined &&
      normalized.login !== undefined &&
      normalized.login !== request.login
    ) {
      return yield* new ConnectedAccountBadRequestError({
        message: loginMismatch(request.provider, request.login, normalized.login),
      });
    }

    const credentialCipher = yield* CredentialCipher;
    const sealed = yield* credentialCipher.encrypt(normalized.payloadJson).pipe(
      Effect.mapError(
        (error) =>
          new ConnectedAccountInternalServerError({
            message: toErrorMessage(error, "Failed to encrypt credential."),
          }),
      ),
    );
    const payloadSha256 = sha256Hex(normalized.payloadJson);

    const connectedAccountRepo = yield* ConnectedAccountRepo;

    return yield* withOwnerLock(
      request.ownerUserId,
      Effect.gen(function* () {
        const existing = yield* withInternalError(
          connectedAccountRepo.listByOwnerProvider({
            ownerUserId: request.ownerUserId,
            provider: request.provider,
          }),
          "Failed to look up connected accounts.",
        );
        const storedLogins = new Map(
          normalized.login === undefined
            ? []
            : yield* Effect.forEach(existing, (account) =>
                storedLoginOf(credentialCipher, account).pipe(
                  Effect.map((stored) => [account.id, stored] as const),
                ),
              ),
        );
        const target = yield* connectTarget(
          request.provider,
          requested,
          existing,
          normalized.login,
          storedLogins,
        );

        const account =
          target.kind === "replace"
            ? yield* withInternalError(
                connectedAccountRepo.replacePayload({
                  id: target.account.id,
                  // Reconnecting may switch payload shapes (claude setup-token <-> session file).
                  kind: normalized.kind,
                  encryptedPayload: sealed.sealed,
                  encryptionKeyId: sealed.keyId,
                  payloadSha256,
                  metadata: normalized.metadata,
                }),
                "Failed to replace connected account credential.",
              )
            : yield* connectedAccountRepo
                .createConnectedAccount({
                  id: `cacc_${randomUUID()}`,
                  ownerUserId: request.ownerUserId,
                  provider: request.provider,
                  name: target.name,
                  kind: normalized.kind,
                  encryptedPayload: sealed.sealed,
                  encryptionKeyId: sealed.keyId,
                  payloadSha256,
                  metadata: normalized.metadata,
                })
                .pipe(
                  Effect.mapError((error) => {
                    // Owner FK failure means the user id does not exist.
                    if (error.message.includes("violates foreign key constraint")) {
                      return new ConnectedAccountNotFoundError({
                        message: `Owner user not found: ${request.ownerUserId}`,
                      });
                    }

                    return new ConnectedAccountInternalServerError({
                      message: toErrorMessage(error, "Failed to create connected account."),
                    });
                  }),
                );

        if (account === undefined) {
          return yield* new ConnectedAccountInternalServerError({
            message: "Failed to replace connected account credential.",
          });
        }

        if (request.makeDefault === true || existing.length === 0) {
          yield* withInternalError(
            connectedAccountRepo.setDefault({
              ownerUserId: account.ownerUserId,
              provider: account.provider,
              connectedAccountId: account.id,
            }),
            "Failed to set the default connected account.",
          );
        }

        return toConnectedAccountSummary(yield* reloadAccount(account.id));
      }),
    );
  });
};

export const listConnectedAccounts = (input: { readonly ownerUserId: string }) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const items = yield* withInternalError(
      connectedAccountRepo.listByOwner(input.ownerUserId),
      "Failed to list connected accounts.",
    );
    const hasApiKeyHistory = yield* withInternalError(
      connectedAccountRepo.hasApiKeyHistory(input.ownerUserId),
      "Failed to list connected accounts.",
    );

    return {
      items: items.map(toConnectedAccountSummary),
      hasApiKeyHistory,
    } satisfies ListConnectedAccountsResponse;
  });
};

export const setConnectedAccountDefault = (input: {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
  readonly connectedAccountId: string;
}) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    return yield* withOwnerLock(
      input.ownerUserId,
      Effect.gen(function* () {
        const account = yield* withInternalError(
          connectedAccountRepo.getById(input.connectedAccountId),
          "Failed to load connected account.",
        );

        if (
          account === undefined ||
          account.ownerUserId !== input.ownerUserId ||
          account.provider !== input.provider ||
          account.archivedAt !== null
        ) {
          return yield* new ConnectedAccountNotFoundError({
            message: `No ${input.provider} connected account ${input.connectedAccountId}.`,
          });
        }

        if (account.status !== "active") {
          return yield* new ConnectedAccountConflictError({
            message: `Connected ${input.provider} account "${account.name}" is invalid. Reconnect it before choosing it as the default.`,
            code: "connected-account-invalid",
          });
        }

        yield* withInternalError(
          connectedAccountRepo.setDefault({
            ownerUserId: account.ownerUserId,
            provider: account.provider,
            connectedAccountId: account.id,
          }),
          "Failed to set the default connected account.",
        );

        return toConnectedAccountSummary({ ...account, isDefault: true });
      }),
    );
  });
};

export const archiveConnectedAccount = (input: {
  readonly connectedAccountId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    return yield* withOwnerLock(
      input.ownerUserId,
      Effect.gen(function* () {
        const archived = yield* withInternalError(
          connectedAccountRepo.archiveAndClearDefault({
            id: input.connectedAccountId,
            ownerUserId: input.ownerUserId,
          }),
          "Failed to disconnect account.",
        );

        // Uniform 404: unknown id, someone else's account, and already-archived all look identical.
        if (archived === undefined) {
          return yield* new ConnectedAccountNotFoundError({
            message: `Connected account not found: ${input.connectedAccountId}`,
          });
        }

        return toConnectedAccountSummary({ ...archived, isDefault: false });
      }),
    );
  });
};

export const markConnectedAccountInvalid = (input: {
  readonly connectedAccountId: string;
  readonly ownerUserId: string;
  readonly revision?: number;
}) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const notFound = new ConnectedAccountNotFoundError({
      message: `Connected account not found: ${input.connectedAccountId}`,
    });
    const usable = (account: ConnectedAccount | undefined): account is ConnectedAccount =>
      account !== undefined &&
      account.ownerUserId === input.ownerUserId &&
      account.archivedAt === null;

    const account = yield* withInternalError(
      connectedAccountRepo.getById(input.connectedAccountId),
      "Failed to load connected account.",
    );

    if (!usable(account)) {
      return yield* notFound;
    }

    const marked = yield* withInternalError(
      connectedAccountRepo.markInvalid({
        id: account.id,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      }),
      "Failed to mark connected account invalid.",
    );

    const current = yield* withInternalError(
      connectedAccountRepo.getById(account.id),
      "Failed to load connected account.",
    );

    if (!usable(current)) {
      return yield* notFound;
    }

    return {
      ...toConnectedAccountSummary(current),
      outcome: marked === undefined ? "superseded" : "marked",
    } satisfies MarkConnectedAccountInvalidResponse;
  });
};
