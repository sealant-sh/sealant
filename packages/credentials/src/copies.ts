/*
Copies that cannot rotate (design doc §6a "One refresher").

The store holds the only refresh token of a Claude or Codex login, and only the keep-fresh worker
refreshes it (through the official CLI). Everything else — a workspace launch, an inference call, a
push into a running workspace — gets a copy its holder cannot refresh:

- Claude: `claudeAiOauth` without `refreshToken`. Claude Code runs on the access token and re-reads
  the file before every request, so a pushed copy takes effect on the next request.
- Codex: `tokens.refresh_token` replaced by a placeholder no provider accepts. Codex requires the
  field (without it the login does not load), reloads auth.json from disk after a 401, and keeps
  using its access token when a refresh fails.

A copy works until its access token expires and cannot spend, rotate or revoke the login. Tested
2026-10-01 against Claude Code 2.1.286 and Codex 0.159.2.
*/

/** Stands in for Codex's refresh token in every copy; never a token any provider issues. */
export const CODEX_COPY_REFRESH_TOKEN = "sealant-copy-cannot-refresh";

export class CredentialCopyError extends Error {
  override readonly name = "CredentialCopyError";
}

const parseObject = (raw: string, what: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CredentialCopyError(`${what} is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CredentialCopyError(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
};

/** A Claude session file whose holder cannot refresh it: `claudeAiOauth` without `refreshToken`. */
export const claudeCredentialsCopy = (credentialsJson: string): string => {
  const document = parseObject(credentialsJson, "the Claude credentials file");
  const grant = document["claudeAiOauth"];
  if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
    throw new CredentialCopyError("the Claude credentials file has no claudeAiOauth grant");
  }
  const { refreshToken: _refreshToken, ...withoutRefresh } = grant as Record<string, unknown>;
  return JSON.stringify({ ...document, claudeAiOauth: withoutRefresh });
};

/**
 * Never in the past: a setup token has no expiry Claude Code could read, and a file with none in
 * the future would read as expired. Year 2286, as Mend's own seed writes it.
 */
export const CLAUDE_SETUP_TOKEN_EXPIRES_AT = 9_999_999_999_999;

/**
 * A Claude setup token (`claude setup-token`) as a credentials file, so it is injected like a
 * session login and can be written per home and replaced in a running workspace
 * (docs/connected-accounts-design.md §6b). It has what Claude Code builds for itself from `CLAUDE_CODE_OAUTH_TOKEN`: the token as the access
 * token, inference scope, no subscription, and no refresh token, so nothing tries to refresh it.
 */
export const claudeSetupTokenCredentials = (token: string): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      expiresAt: CLAUDE_SETUP_TOKEN_EXPIRES_AT,
      scopes: ["user:inference"],
      subscriptionType: null,
    },
  });

/** A Codex auth.json whose holder cannot refresh it: the refresh token is a placeholder. */
export const codexAuthJsonCopy = (authJson: string): string => {
  const document = parseObject(authJson, "the Codex auth.json");
  const tokens = document["tokens"];
  // An API-key login has no tokens and nothing to refresh: it is its own copy.
  if (tokens === null || tokens === undefined) return JSON.stringify(document);
  if (typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new CredentialCopyError("the Codex auth.json has malformed tokens");
  }
  return JSON.stringify({
    ...document,
    tokens: { ...(tokens as Record<string, unknown>), refresh_token: CODEX_COPY_REFRESH_TOKEN },
  });
};

/** Whether a Claude session file carries a refresh token (the store's own copy always does). */
export const claudeCredentialsCanRefresh = (credentialsJson: string): boolean => {
  try {
    const grant = parseObject(credentialsJson, "the Claude credentials file")["claudeAiOauth"];
    if (typeof grant !== "object" || grant === null) return false;
    const refreshToken = (grant as Record<string, unknown>)["refreshToken"];
    return typeof refreshToken === "string" && refreshToken !== "";
  } catch {
    return false;
  }
};

/** Whether a Codex auth.json carries a real refresh token (not a copy's placeholder). */
export const codexAuthJsonCanRefresh = (authJson: string): boolean => {
  try {
    const tokens = parseObject(authJson, "the Codex auth.json")["tokens"];
    if (typeof tokens !== "object" || tokens === null) return false;
    const refreshToken = (tokens as Record<string, unknown>)["refresh_token"];
    return (
      typeof refreshToken === "string" &&
      refreshToken !== "" &&
      refreshToken !== CODEX_COPY_REFRESH_TOKEN
    );
  } catch {
    return false;
  }
};
