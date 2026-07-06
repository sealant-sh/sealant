import { Schema } from "effect";

/*
Provider credential payload shapes — the JSON that gets encrypted at rest (see design doc §3–4).
Payloads carry ONLY the secret material; non-secret display/ops data is extracted into the
`metadata` column at connect time (see `parseCodexAuthJson`).
*/

export const connectedAccountProviders = ["claude", "codex", "github"] as const;
export type ConnectedAccountProvider = (typeof connectedAccountProviders)[number];

export const connectedAccountProviderSchema = Schema.Literals(connectedAccountProviders);

// ---------------------------------------------------------------------------
// Claude — `claude setup-token` output (1-year, inference-scoped, no refresh).
// ---------------------------------------------------------------------------

export const CLAUDE_TOKEN_PREFIX = "sk-ant-oat01-";

export const claudeCredentialPayloadSchema = Schema.Struct({
  token: Schema.String.check(Schema.isStartsWith(CLAUDE_TOKEN_PREFIX)),
});
export type ClaudeCredentialPayload = typeof claudeCredentialPayloadSchema.Type;

export const parseClaudeCredentialPayload = Schema.decodeUnknownSync(claudeCredentialPayloadSchema);

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

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
};

const asNonEmptyString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

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
