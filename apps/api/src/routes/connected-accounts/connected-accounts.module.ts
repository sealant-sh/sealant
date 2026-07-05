import { randomUUID } from "node:crypto";

import {
  ConnectedAccountBadRequestError,
  ConnectedAccountConflictError,
  ConnectedAccountInternalServerError,
  ConnectedAccountNotFoundError,
  ConnectedAccountServiceUnavailableError,
  type ConnectedAccountSummary,
  type CreateConnectedAccountRequest,
  type ListConnectedAccountsResponse,
} from "@sealant/api-contracts";
import {
  CLAUDE_TOKEN_PREFIX,
  CredentialCipher,
  parseCodexAuthJson,
  sha256Hex,
  type ConnectedAccountProvider,
} from "@sealant/credentials";
import { ConnectedAccountRepo, type ConnectedAccount } from "@sealant/db";
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

export const toConnectedAccountSummary = (account: ConnectedAccount): ConnectedAccountSummary => {
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
  };
};

interface NormalizedCredential {
  /** "oauth-token" (claude) | "auth-json" (codex) | "gh-cli-token" (github). */
  readonly kind: string;
  /** JSON payload string that gets sealed — the only place secret material lives. */
  readonly payloadJson: string;
  /** NON-secret display/ops data persisted in the metadata column. */
  readonly metadata: Record<string, unknown>;
}

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

const normalizeSecret = (
  provider: ConnectedAccountProvider,
  secret: string,
): Effect.Effect<NormalizedCredential, ConnectedAccountBadRequestError> => {
  return Effect.gen(function* () {
    switch (provider) {
      case "claude": {
        const token = secret.trim();

        if (!token.startsWith(CLAUDE_TOKEN_PREFIX)) {
          return yield* new ConnectedAccountBadRequestError({
            message: `Claude token must start with "${CLAUDE_TOKEN_PREFIX}" — run \`claude setup-token\` and paste its output.`,
          });
        }

        return {
          kind: "oauth-token",
          payloadJson: JSON.stringify({ token }),
          metadata: { tokenSuffix: token.slice(-4), connectedVia: "paste" },
        };
      }
      case "codex": {
        const parsed = parseCodexAuthJson(secret);

        if (!parsed.valid) {
          return yield* new ConnectedAccountBadRequestError({ message: parsed.reason });
        }

        return {
          kind: "auth-json",
          // Stored verbatim so the exact file can be re-materialized in the sandbox.
          payloadJson: JSON.stringify({ authJson: secret }),
          metadata: { ...parsed.metadata },
        };
      }
      case "github": {
        const token = secret.trim();
        const verification = yield* verifyGitHubToken(token);

        if (verification.outcome === "rejected") {
          return yield* new ConnectedAccountBadRequestError({
            message: "GitHub rejected this token. Run `gh auth token` and paste a current one.",
          });
        }

        return {
          kind: "gh-cli-token",
          payloadJson: JSON.stringify({ token }),
          metadata:
            verification.outcome === "verified"
              ? {
                  ...(verification.login === undefined ? {} : { login: verification.login }),
                  scopes: verification.scopes,
                  tokenType: "gh-cli",
                  scopesVerified: true,
                }
              : { tokenType: "gh-cli", scopesVerified: false },
        };
      }
    }
  });
};

export const createConnectedAccount = (input: {
  readonly payload: CreateConnectedAccountRequest;
}) => {
  return Effect.gen(function* () {
    yield* requireCredentialsKey;

    const normalized = yield* normalizeSecret(input.payload.provider, input.payload.secret);

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
    const name = input.payload.name ?? "default";

    // Upsert on (owner, provider, name): reconnecting swaps the sealed payload on the active row
    // in place (also resets status to "active" and clears invalid_at).
    const existing = yield* withInternalError(
      connectedAccountRepo.getByOwnerProviderName({
        ownerUserId: input.payload.ownerUserId,
        provider: input.payload.provider,
        name,
      }),
      "Failed to look up connected account.",
    );

    if (existing !== undefined) {
      const replaced = yield* withInternalError(
        connectedAccountRepo.replacePayload({
          id: existing.id,
          encryptedPayload: sealed.sealed,
          encryptionKeyId: sealed.keyId,
          payloadSha256,
          metadata: normalized.metadata,
        }),
        "Failed to replace connected account credential.",
      );

      if (replaced === undefined) {
        return yield* new ConnectedAccountInternalServerError({
          message: "Failed to replace connected account credential.",
        });
      }

      return toConnectedAccountSummary(replaced);
    }

    // No active row: insert fresh. Archived rows never block this — the (owner, provider, name)
    // unique index is partial on `archived_at IS NULL` — so reconnecting after an archive just
    // creates a new account row.
    const created = yield* connectedAccountRepo
      .createConnectedAccount({
        id: `cacc_${randomUUID()}`,
        ownerUserId: input.payload.ownerUserId,
        provider: input.payload.provider,
        name,
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
              message: `Owner user not found: ${input.payload.ownerUserId}`,
            });
          }

          // Concurrent connect for the same (owner, provider, name) won the race.
          if (error.message.includes("duplicate key value")) {
            return new ConnectedAccountConflictError({
              message: `A ${input.payload.provider} account named "${name}" is already connected.`,
            });
          }

          return new ConnectedAccountInternalServerError({
            message: toErrorMessage(error, "Failed to create connected account."),
          });
        }),
      );

    return toConnectedAccountSummary(created);
  });
};

export const listConnectedAccounts = (input: { readonly ownerUserId: string }) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const items = yield* withInternalError(
      connectedAccountRepo.listByOwner(input.ownerUserId),
      "Failed to list connected accounts.",
    );

    return {
      items: items.map(toConnectedAccountSummary),
    } satisfies ListConnectedAccountsResponse;
  });
};

export const archiveConnectedAccount = (input: {
  readonly connectedAccountId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const archived = yield* withInternalError(
      connectedAccountRepo.archive({
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

    return toConnectedAccountSummary(archived);
  });
};

export const markConnectedAccountInvalid = (input: {
  readonly connectedAccountId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const account = yield* withInternalError(
      connectedAccountRepo.getById(input.connectedAccountId),
      "Failed to load connected account.",
    );

    if (
      account === undefined ||
      account.ownerUserId !== input.ownerUserId ||
      account.archivedAt !== null
    ) {
      return yield* new ConnectedAccountNotFoundError({
        message: `Connected account not found: ${input.connectedAccountId}`,
      });
    }

    const marked = yield* withInternalError(
      connectedAccountRepo.markInvalid({ id: account.id }),
      "Failed to mark connected account invalid.",
    );

    if (marked === undefined) {
      return yield* new ConnectedAccountNotFoundError({
        message: `Connected account not found: ${input.connectedAccountId}`,
      });
    }

    return toConnectedAccountSummary(marked);
  });
};
