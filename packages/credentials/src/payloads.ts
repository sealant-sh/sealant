import { Schema } from "effect";

/*
Provider credential payload shapes — the JSON that gets encrypted at rest (see design doc §3–4).
Payloads carry ONLY the secret material; non-secret display/ops data is extracted into the
`metadata` column at connect time (see `parseCodexAuthJson`).
*/

export const connectedAccountProviders = ["claude", "codex", "github"] as const;
export type ConnectedAccountProvider = (typeof connectedAccountProviders)[number];

export const connectedAccountProviderSchema = Schema.Literals(connectedAccountProviders);

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
};

const asNonEmptyString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

// ---------------------------------------------------------------------------
// Claude — two credential shapes:
//  - setup-token: `claude setup-token` output (1-year, inference-scoped, no
//    refresh; Anthropic classifies it as API auth).
//  - credentials file: ~/.claude/.credentials.json contents that the operator
//    minted for Sealant (e.g. via a second CLAUDE_CONFIG_DIR login) — a full
//    Claude Code session that presents as the user's subscription. Stored as
//    its `claudeAiOauth` grant alone, so the file re-materializes in the
//    workspace without the MCP refresh tokens that sat beside it.
// ---------------------------------------------------------------------------

export const CLAUDE_TOKEN_PREFIX = "sk-ant-oat01-";

export const claudeTokenCredentialPayloadSchema = Schema.Struct({
  token: Schema.String.check(Schema.isStartsWith(CLAUDE_TOKEN_PREFIX)),
});
export type ClaudeTokenCredentialPayload = typeof claudeTokenCredentialPayloadSchema.Type;

export const claudeCredentialsFilePayloadSchema = Schema.Struct({
  credentialsJson: Schema.String.check(Schema.isNonEmpty()),
});
export type ClaudeCredentialsFilePayload = typeof claudeCredentialsFilePayloadSchema.Type;

/**
 * Either claude shape; consumers dispatch on the payload SHAPE (`"token" in payload`), never on
 * the db `kind` column (which can lag behind a reconnect that switched shapes).
 */
export const claudeCredentialPayloadSchema = Schema.Union([
  claudeTokenCredentialPayloadSchema,
  claudeCredentialsFilePayloadSchema,
]);
export type ClaudeCredentialPayload = typeof claudeCredentialPayloadSchema.Type;

export const parseClaudeCredentialPayload = Schema.decodeUnknownSync(claudeCredentialPayloadSchema);
export const parseClaudeCredentialsFilePayload = Schema.decodeUnknownSync(
  claudeCredentialsFilePayloadSchema,
);

/** Non-secret metadata extracted from .credentials.json at connect/sync time (design doc §3). */
export interface ClaudeCredentialsMetadata {
  /** Last 4 characters of the access token — display parity with setup-token accounts. */
  readonly tokenSuffix?: string;
  readonly subscriptionType?: string;
  /** `claudeAiOauth.expiresAt` (epoch millis) — the sync-back's newest-wins freshness marker. */
  readonly expiresAt?: number;
  /**
   * `claudeAiOauth.refreshTokenExpiresAt` (epoch millis): when the grant itself dies, not the
   * access token. Absent on an older stored row and on a file that did not carry it.
   */
  readonly refreshTokenExpiresAt?: number;
  readonly scopeCount?: number;
}

export type ParseClaudeCredentialsJsonResult =
  | { readonly valid: true; readonly metadata: ClaudeCredentialsMetadata }
  | { readonly valid: false; readonly reason: string };

/**
 * Validates verbatim ~/.claude/.credentials.json contents and extracts non-secret metadata.
 *
 * Shape (extra fields tolerated): `{ claudeAiOauth: { accessToken, refreshToken?, expiresAt?,
 * scopes?, subscriptionType? } }`. Requires a non-empty `claudeAiOauth.accessToken`; everything
 * else degrades to absent metadata rather than failing the parse.
 */
/** The one section of a Claude credentials file the platform stores and a workspace needs. */
export const CLAUDE_GRANT_SECTION = "claudeAiOauth";

/** What {@link narrowClaudeCredentialsJson} did, so a caller can log it without the contents. */
export interface NarrowedClaudeCredentialsJson {
  /** The document to store: the grant alone, or the input untouched when it has no grant. */
  readonly credentialsJson: string;
  /** Sections left out, named for the log. Empty when there was nothing else to leave out. */
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Keep the Claude grant and drop everything beside it.
 *
 * A `.credentials.json` is `{ claudeAiOauth, mcpOAuth }`, and `mcpOAuth` holds refresh tokens for
 * whichever MCP servers the person authorized on their own machine — Figma, Atlassian, Linear.
 * Those belong to that machine. Stored whole they reach this database and every workspace that
 * attaches the account, which is a wider blast radius than anyone asked for (Mend's ADR 0005).
 *
 * The workspace loses nothing: Claude Code reads its grant from `claudeAiOauth`, and the MCP
 * section is for MCP servers the workspace does not have. A payload with no grant section comes
 * back untouched, because narrowing something this does not understand is how a credential gets
 * mangled; the caller's own validation decides whether to accept it.
 */
export const narrowClaudeCredentialsJson = (raw: string): NarrowedClaudeCredentialsJson => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { credentialsJson: raw, dropped: [] };
  }

  const root = asRecord(parsed);
  const grant = root === undefined ? undefined : root[CLAUDE_GRANT_SECTION];

  if (root === undefined || grant === undefined) {
    return { credentialsJson: raw, dropped: [] };
  }

  const dropped = Object.keys(root)
    .filter((key) => key !== CLAUDE_GRANT_SECTION)
    .toSorted();

  // Nothing to drop means nothing to rewrite: the file is stored exactly as it arrived, so a
  // credential this never had to touch re-materializes byte for byte.
  if (dropped.length === 0) {
    return { credentialsJson: raw, dropped };
  }

  return {
    // Two spaces and a trailing newline: the shape Claude Code writes, so the file this
    // re-materializes in a workspace still reads like the one the person logged in with.
    credentialsJson: `${JSON.stringify({ [CLAUDE_GRANT_SECTION]: grant }, undefined, 2)}\n`,
    dropped,
  };
};

export const parseClaudeCredentialsJson = (raw: string): ParseClaudeCredentialsJsonResult => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, reason: ".credentials.json is not valid JSON." };
  }

  const root = asRecord(parsed);

  if (root === undefined) {
    return { valid: false, reason: ".credentials.json must be a JSON object." };
  }

  const oauth = asRecord(root.claudeAiOauth);

  if (oauth === undefined) {
    return { valid: false, reason: ".credentials.json must contain a claudeAiOauth object." };
  }

  const accessToken = asNonEmptyString(oauth.accessToken);

  if (accessToken === undefined) {
    return { valid: false, reason: ".credentials.json must contain claudeAiOauth.accessToken." };
  }

  const subscriptionType = asNonEmptyString(oauth.subscriptionType);
  const expiresAt =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : undefined;
  const scopeCount = Array.isArray(oauth.scopes) ? oauth.scopes.length : undefined;
  // The grant's own life, beside the access token's. Non-secret, and the number a surface needs to
  // say "this expires on the 15th" instead of finding out when a harness cannot authenticate.
  const refreshTokenExpiresAt =
    typeof oauth.refreshTokenExpiresAt === "number" && Number.isFinite(oauth.refreshTokenExpiresAt)
      ? oauth.refreshTokenExpiresAt
      : undefined;

  return {
    valid: true,
    metadata: {
      tokenSuffix: accessToken.slice(-4),
      ...(subscriptionType === undefined ? {} : { subscriptionType }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
      ...(scopeCount === undefined ? {} : { scopeCount }),
    },
  };
};

/** SECRET material pulled out of a .credentials.json for the Agent-SDK env path. */
export interface ClaudeOauthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
}

/**
 * SECRET-bearing extraction (unlike {@link parseClaudeCredentialsJson}): returns the access and
 * refresh tokens so callers can pass the access token to the Agent SDK and redact BOTH from any
 * outbound error text. Returns undefined when the shape is unusable; never throws.
 */
export const extractClaudeOauthCredentials = (
  credentialsJson: string,
): ClaudeOauthCredentials | undefined => {
  try {
    const root = asRecord(JSON.parse(credentialsJson));
    const oauth = root === undefined ? undefined : asRecord(root.claudeAiOauth);
    const accessToken = oauth === undefined ? undefined : asNonEmptyString(oauth.accessToken);

    if (oauth === undefined || accessToken === undefined) {
      return undefined;
    }

    return { accessToken, refreshToken: asNonEmptyString(oauth.refreshToken) };
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Codex — verbatim ~/.codex/auth.json contents (stored as-is so the exact file
// can be re-materialized in the workspace; the official CLI refreshes it there).
// ---------------------------------------------------------------------------

export const codexCredentialPayloadSchema = Schema.Struct({
  authJson: Schema.String.check(Schema.isNonEmpty()),
});
export type CodexCredentialPayload = typeof codexCredentialPayloadSchema.Type;

export const parseCodexCredentialPayload = Schema.decodeUnknownSync(codexCredentialPayloadSchema);

/** Non-secret metadata extracted from auth.json at connect time (design doc §3). */
export interface CodexAuthMetadata {
  readonly accountId?: string;
  readonly authMode?: string;
  readonly lastRefresh?: string;
  readonly email?: string;
}

export type ParseCodexAuthJsonResult =
  | { readonly valid: true; readonly metadata: CodexAuthMetadata }
  | { readonly valid: false; readonly reason: string };

/**
 * Best-effort decode of a JWT payload segment (base64url middle part, NO signature
 * verification — we only read non-secret display claims). Never throws: any structural
 * weirdness yields `undefined`.
 */
const decodeJwtPayloadClaims = (idToken: string): Record<string, unknown> | undefined => {
  try {
    const payloadSegment = idToken.split(".")[1];

    if (payloadSegment === undefined || payloadSegment.length === 0) {
      return undefined;
    }

    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");

    return asRecord(JSON.parse(decoded));
  } catch {
    return undefined;
  }
};

const extractAccountIdFromClaims = (claims: Record<string, unknown>): string | undefined => {
  const topLevel = asNonEmptyString(claims.chatgpt_account_id);

  if (topLevel !== undefined) {
    return topLevel;
  }

  const authClaim = asRecord(claims["https://api.openai.com/auth"]);
  const nested =
    authClaim === undefined ? undefined : asNonEmptyString(authClaim.chatgpt_account_id);

  if (nested !== undefined) {
    return nested;
  }

  const organizations = claims.organizations;

  if (Array.isArray(organizations)) {
    const firstOrganization = asRecord(organizations[0]);

    return firstOrganization === undefined ? undefined : asNonEmptyString(firstOrganization.id);
  }

  return undefined;
};

/**
 * Validates verbatim ~/.codex/auth.json contents and extracts non-secret metadata.
 *
 * Shape (extra fields tolerated): `{ OPENAI_API_KEY?: string|null, tokens?: { id_token?,
 * access_token?, refresh_token?, account_id? }, last_refresh?, auth_mode? }`. Requires
 * `tokens.refresh_token` or `OPENAI_API_KEY` to be present. Weird/malformed id_token JWTs never
 * fail the parse — the derived metadata fields just come back undefined.
 */
export const parseCodexAuthJson = (raw: string): ParseCodexAuthJsonResult => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, reason: "auth.json is not valid JSON." };
  }

  const root = asRecord(parsed);

  if (root === undefined) {
    return { valid: false, reason: "auth.json must be a JSON object." };
  }

  const tokens = asRecord(root.tokens);
  const openaiApiKey = asNonEmptyString(root.OPENAI_API_KEY);
  const refreshToken = tokens === undefined ? undefined : asNonEmptyString(tokens.refresh_token);

  if (refreshToken === undefined && openaiApiKey === undefined) {
    return {
      valid: false,
      reason: "auth.json must contain tokens.refresh_token or OPENAI_API_KEY.",
    };
  }

  const idToken = tokens === undefined ? undefined : asNonEmptyString(tokens.id_token);
  const claims = idToken === undefined ? undefined : decodeJwtPayloadClaims(idToken);
  const accountId =
    (tokens === undefined ? undefined : asNonEmptyString(tokens.account_id)) ??
    (claims === undefined ? undefined : extractAccountIdFromClaims(claims));
  const email = claims === undefined ? undefined : asNonEmptyString(claims.email);
  const authMode = asNonEmptyString(root.auth_mode);
  const lastRefresh = asNonEmptyString(root.last_refresh);

  return {
    valid: true,
    metadata: {
      ...(accountId === undefined ? {} : { accountId }),
      ...(authMode === undefined ? {} : { authMode }),
      ...(lastRefresh === undefined ? {} : { lastRefresh }),
      ...(email === undefined ? {} : { email }),
    },
  };
};

/**
 * SECRET-bearing extraction (unlike {@link parseCodexAuthJson}): returns every token-like value an
 * auth.json can carry so callers can redact ALL of them from any outbound error text (the codex
 * inference engine's stderr can echo whichever one the CLI used). Returns an empty list when the
 * shape is unusable; never throws.
 */
export const extractCodexSecrets = (authJson: string): readonly string[] => {
  try {
    const root = asRecord(JSON.parse(authJson));

    if (root === undefined) {
      return [];
    }

    const tokens = asRecord(root.tokens);

    return [
      asNonEmptyString(root.OPENAI_API_KEY),
      ...(tokens === undefined
        ? []
        : [
            asNonEmptyString(tokens.access_token),
            asNonEmptyString(tokens.refresh_token),
            asNonEmptyString(tokens.id_token),
          ]),
    ].filter((secret): secret is string => secret !== undefined);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// GitHub — gh CLI token (`gh auth token`). Any non-empty token is accepted at
// the schema level; prefix knowledge is warn-level and lives in callers.
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN_PREFIXES = ["gho_", "ghp_", "github_pat_"] as const;

export const githubCredentialPayloadSchema = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
});
export type GitHubCredentialPayload = typeof githubCredentialPayloadSchema.Type;

export const parseGitHubCredentialPayload = Schema.decodeUnknownSync(githubCredentialPayloadSchema);

export const hasKnownGitHubTokenPrefix = (token: string): boolean => {
  return GITHUB_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));
};
