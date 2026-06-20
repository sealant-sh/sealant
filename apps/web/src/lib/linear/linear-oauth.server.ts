import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getSealantAuth } from "@sealant/auth/server";
import { getAuthSession } from "@sealant/auth/session";
import {
  importLinearIssues,
  IssueWorkflowImportHttpError,
  type IssueWorkflowImportResult,
} from "@sealant/issues";

const linearAuthorizeUrl = "https://linear.app/oauth/authorize";
const linearTokenUrl = "https://api.linear.app/oauth/token";
const linearStateCookieName = "sealant_linear_oauth_state";
const linearTokenCookieName = "sealant_linear_oauth_token";
const stateCookieMaxAgeSeconds = 10 * 60;
const tokenCookieMaxAgeSeconds = 30 * 24 * 60 * 60;
const tokenRefreshWindowMs = 5 * 60 * 1000;

type JsonRecord = Readonly<Record<string, unknown>>;

interface LinearOAuthConfig {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly cookieSecret: string | null;
  readonly redirectUri: string | null;
  readonly scopes: readonly string[];
  readonly teamId: string | null;
  readonly first: number;
  readonly maxPages: number;
}

interface ConfiguredLinearOAuthConfig extends LinearOAuthConfig {
  readonly clientId: string;
  readonly cookieSecret: string;
}

interface LinearOAuthStateCookie {
  readonly kind: "linear-oauth-state";
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly userId: string;
}

interface LinearOAuthTokenCookie {
  readonly kind: "linear-oauth-token";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly scope: readonly string[];
  readonly expiresAt: string;
  readonly connectedAt: string;
  readonly userId: string;
}

interface LinearTokenPayload {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly scope: readonly string[];
  readonly expiresIn: number;
}

interface LinearStatusResponse {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly expiresAt: string | null;
  readonly reason: string | null;
  readonly scopes: readonly string[];
}

interface LinearImportResponse extends IssueWorkflowImportResult {
  readonly connected: true;
}

interface LinearErrorResponse {
  readonly error: string;
}

export async function handleLinearConnectRequest(request: Request): Promise<Response> {
  const session = await readAuthenticatedSession(request);

  if (session === null) {
    return redirectToLogin(request);
  }

  const config = readLinearOAuthConfig();
  const configurationIssue = getLinearOAuthConfigurationIssue(config);
  const requestUrl = new URL(request.url);
  const returnTo = normalizeReturnTo(requestUrl.searchParams.get("returnTo"));

  if (configurationIssue !== null || !isConfiguredLinearOAuthConfig(config)) {
    return redirectToIssueWorkflow(returnTo, "configuration", request);
  }

  const state = createRandomToken();
  const codeVerifier = createRandomToken();
  const redirectUri = resolveLinearRedirectUri(request, config);
  const stateCookie: LinearOAuthStateCookie = {
    kind: "linear-oauth-state",
    state,
    codeVerifier,
    createdAt: new Date().toISOString(),
    redirectUri,
    returnTo,
    userId: session.user.id,
  };
  const authorizeUrl = new URL(linearAuthorizeUrl);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.scopes.join(","));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", createCodeChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({
    Location: authorizeUrl.toString(),
  });
  headers.append(
    "Set-Cookie",
    serializeCookie(
      linearStateCookieName,
      sealCookiePayload(stateCookie, config.cookieSecret),
      request,
      stateCookieMaxAgeSeconds,
    ),
  );

  return new Response(null, {
    headers,
    status: 302,
  });
}

export async function handleLinearCallbackRequest(request: Request): Promise<Response> {
  const session = await readAuthenticatedSession(request);

  if (session === null) {
    return redirectToLogin(request);
  }

  const config = readLinearOAuthConfig();
  const configurationIssue = getLinearOAuthConfigurationIssue(config);

  if (configurationIssue !== null || !isConfiguredLinearOAuthConfig(config)) {
    return redirectToIssueWorkflow("/issues", "configuration", request);
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const stateCookie = readStateCookie(cookies, config.cookieSecret);
  const requestUrl = new URL(request.url);
  const returnedState = requestUrl.searchParams.get("state");
  const code = requestUrl.searchParams.get("code");
  const oauthError = requestUrl.searchParams.get("error");
  const clearStateCookie = expireCookie(linearStateCookieName, request);

  if (oauthError !== null) {
    return redirectToIssueWorkflow(stateCookie?.returnTo ?? "/issues", "error", request, [
      clearStateCookie,
    ]);
  }

  if (
    stateCookie === null ||
    returnedState === null ||
    returnedState !== stateCookie.state ||
    stateCookie.userId !== session.user.id ||
    code === null
  ) {
    return redirectToIssueWorkflow(stateCookie?.returnTo ?? "/issues", "error", request, [
      clearStateCookie,
    ]);
  }

  try {
    const tokenPayload = await exchangeAuthorizationCodeForToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier: stateCookie.codeVerifier,
      redirectUri: stateCookie.redirectUri,
    });
    const tokenCookie = createTokenCookie(tokenPayload, session.user.id);
    const headers = new Headers({
      Location: createIssueWorkflowRedirectUrl(stateCookie.returnTo, "connected", request),
    });
    headers.append("Set-Cookie", clearStateCookie);
    headers.append(
      "Set-Cookie",
      serializeCookie(
        linearTokenCookieName,
        sealCookiePayload(tokenCookie, config.cookieSecret),
        request,
        tokenCookieMaxAgeSeconds,
      ),
    );

    return new Response(null, {
      headers,
      status: 302,
    });
  } catch {
    return redirectToIssueWorkflow(stateCookie.returnTo, "error", request, [clearStateCookie]);
  }
}

export async function handleLinearStatusRequest(request: Request): Promise<Response> {
  const session = await readAuthenticatedSession(request);

  if (session === null) {
    return jsonResponse<LinearErrorResponse>({ error: "Authentication required." }, 401);
  }

  const config = readLinearOAuthConfig();
  const configurationIssue = getLinearOAuthConfigurationIssue(config);

  if (configurationIssue !== null || !isConfiguredLinearOAuthConfig(config)) {
    const reason = configurationIssue ?? "Linear OAuth is not configured.";

    return jsonResponse<LinearStatusResponse>({
      configured: false,
      connected: false,
      expiresAt: null,
      reason,
      scopes: config.scopes,
    });
  }

  const tokenCookie = readTokenCookie(
    parseCookies(request.headers.get("cookie")),
    config.cookieSecret,
  );

  if (tokenCookie === null || tokenCookie.userId !== session.user.id) {
    return jsonResponse<LinearStatusResponse>({
      configured: true,
      connected: false,
      expiresAt: null,
      reason: "Connect Linear before importing issue workflows.",
      scopes: config.scopes,
    });
  }

  return jsonResponse<LinearStatusResponse>({
    configured: true,
    connected: true,
    expiresAt: tokenCookie.expiresAt,
    reason: null,
    scopes: config.scopes,
  });
}

export async function handleLinearImportRequest(request: Request): Promise<Response> {
  const session = await readAuthenticatedSession(request);

  if (session === null) {
    return jsonResponse<LinearErrorResponse>({ error: "Authentication required." }, 401);
  }

  const config = readLinearOAuthConfig();
  const configurationIssue = getLinearOAuthConfigurationIssue(config);

  if (configurationIssue !== null || !isConfiguredLinearOAuthConfig(config)) {
    const reason = configurationIssue ?? "Linear OAuth is not configured.";

    return jsonResponse<LinearErrorResponse>({ error: reason }, 409);
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const tokenCookie = readTokenCookie(cookies, config.cookieSecret);

  if (tokenCookie === null || tokenCookie.userId !== session.user.id) {
    return jsonResponse<LinearErrorResponse>({ error: "Connect Linear before importing." }, 401);
  }

  try {
    const freshToken = await ensureFreshToken(tokenCookie, config);
    const importResult = await importLinearIssues({
      authorization: {
        kind: "oauth",
        accessToken: freshToken.token.accessToken,
      },
      first: config.first,
      importedAt: new Date(),
      maxPages: config.maxPages,
      ...(config.teamId === null ? {} : { teamId: config.teamId }),
    });
    const setCookies =
      freshToken.refreshedToken === null
        ? []
        : [
            serializeCookie(
              linearTokenCookieName,
              sealCookiePayload(freshToken.refreshedToken, config.cookieSecret),
              request,
              tokenCookieMaxAgeSeconds,
            ),
          ];

    return jsonResponse<LinearImportResponse>(
      {
        ...importResult,
        connected: true,
      },
      200,
      setCookies,
    );
  } catch (error) {
    const setCookies =
      error instanceof IssueWorkflowImportHttpError && error.statusCode === 401
        ? [expireCookie(linearTokenCookieName, request)]
        : [];
    const status =
      error instanceof IssueWorkflowImportHttpError && error.statusCode === 401 ? 401 : 502;

    return jsonResponse<LinearErrorResponse>(
      {
        error: error instanceof Error ? error.message : "Unable to import Linear issue workflows.",
      },
      status,
      setCookies,
    );
  }
}

export async function handleLinearDisconnectRequest(request: Request): Promise<Response> {
  const session = await readAuthenticatedSession(request);

  if (session === null) {
    return jsonResponse<LinearErrorResponse>({ error: "Authentication required." }, 401);
  }

  return jsonResponse(
    {
      disconnected: true,
    },
    200,
    [expireCookie(linearTokenCookieName, request)],
  );
}

async function readAuthenticatedSession(request: Request) {
  const auth = await getSealantAuth();
  return getAuthSession(auth, request);
}

function readLinearOAuthConfig(): LinearOAuthConfig {
  return {
    clientId: readEnvString("LINEAR_OAUTH_CLIENT_ID"),
    clientSecret: readEnvString("LINEAR_OAUTH_CLIENT_SECRET"),
    cookieSecret:
      readEnvString("LINEAR_OAUTH_COOKIE_SECRET") ?? readEnvString("BETTER_AUTH_SECRET"),
    redirectUri: readEnvString("LINEAR_OAUTH_REDIRECT_URI"),
    scopes: readScopeList(readEnvString("LINEAR_OAUTH_SCOPES") ?? "read"),
    teamId: readEnvString("LINEAR_IMPORT_TEAM_ID"),
    first: readPositiveInteger("LINEAR_IMPORT_PAGE_SIZE", 50, 100),
    maxPages: readPositiveInteger("LINEAR_IMPORT_MAX_PAGES", 2, 20),
  };
}

function getLinearOAuthConfigurationIssue(config: LinearOAuthConfig): string | null {
  if (config.clientId === null) {
    return "LINEAR_OAUTH_CLIENT_ID is required.";
  }

  if (config.cookieSecret === null) {
    return "LINEAR_OAUTH_COOKIE_SECRET or BETTER_AUTH_SECRET is required.";
  }

  if (config.scopes.length === 0) {
    return "LINEAR_OAUTH_SCOPES must include at least one scope.";
  }

  return null;
}

function isConfiguredLinearOAuthConfig(
  config: LinearOAuthConfig,
): config is ConfiguredLinearOAuthConfig {
  return config.clientId !== null && config.cookieSecret !== null && config.scopes.length > 0;
}

function readEnvString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function readPositiveInteger(name: string, fallback: number, max: number): number {
  const value = readEnvString(name);

  if (value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function readScopeList(value: string): readonly string[] {
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function resolveLinearRedirectUri(request: Request, config: LinearOAuthConfig): string {
  if (config.redirectUri !== null) {
    return config.redirectUri;
  }

  const baseUrl = readEnvString("BETTER_AUTH_URL");
  const origin = baseUrl === null ? new URL(request.url).origin : new URL(baseUrl).origin;

  return new URL("/api/linear/callback", origin).toString();
}

function normalizeReturnTo(value: string | null): string {
  if (value === null || value.length === 0 || !value.startsWith("/") || value.startsWith("//")) {
    return "/issues";
  }

  return value;
}

function redirectToLogin(request: Request): Response {
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("redirect", "/issues");

  return Response.redirect(loginUrl, 302);
}

function redirectToIssueWorkflow(
  returnTo: string,
  linearStatus: string,
  request: Request,
  setCookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    Location: createIssueWorkflowRedirectUrl(returnTo, linearStatus, request),
  });

  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, {
    headers,
    status: 302,
  });
}

function createIssueWorkflowRedirectUrl(
  returnTo: string,
  linearStatus: string,
  request: Request,
): string {
  const redirectUrl = new URL(returnTo, new URL(request.url).origin);
  redirectUrl.searchParams.set("linear", linearStatus);

  return redirectUrl.toString();
}

function createRandomToken(): string {
  return toBase64Url(randomBytes(32));
}

function createCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash("sha256").update(codeVerifier).digest());
}

async function exchangeAuthorizationCodeForToken({
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
}: {
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}): Promise<LinearTokenPayload> {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);

  if (clientSecret !== null) {
    body.set("client_secret", clientSecret);
  }

  return requestLinearToken(body);
}

async function refreshLinearToken(
  tokenCookie: LinearOAuthTokenCookie,
  config: ConfiguredLinearOAuthConfig,
): Promise<LinearTokenPayload> {
  const body = new URLSearchParams();
  body.set("client_id", config.clientId);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", tokenCookie.refreshToken);

  if (config.clientSecret !== null) {
    body.set("client_secret", config.clientSecret);
  }

  return requestLinearToken(body);
}

async function requestLinearToken(body: URLSearchParams): Promise<LinearTokenPayload> {
  const response = await fetch(linearTokenUrl, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Linear OAuth token request failed with status ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const parsedPayload = parseLinearTokenPayload(payload);

  if (parsedPayload === null) {
    throw new Error("Linear OAuth token response was not usable.");
  }

  return parsedPayload;
}

function parseLinearTokenPayload(payload: unknown): LinearTokenPayload | null {
  if (!isJsonRecord(payload)) {
    return null;
  }

  const accessToken = readString(payload, "access_token");
  const refreshToken = readString(payload, "refresh_token");
  const tokenType = readString(payload, "token_type") ?? "Bearer";
  const scope = readScopeValue(payload["scope"]);
  const expiresIn = readNumber(payload, "expires_in");

  if (accessToken === null || refreshToken === null || expiresIn === null) {
    return null;
  }

  return {
    accessToken,
    expiresIn,
    refreshToken,
    scope,
    tokenType,
  };
}

async function ensureFreshToken(
  tokenCookie: LinearOAuthTokenCookie,
  config: ConfiguredLinearOAuthConfig,
): Promise<{
  readonly token: LinearOAuthTokenCookie;
  readonly refreshedToken: LinearOAuthTokenCookie | null;
}> {
  const expiresAt = new Date(tokenCookie.expiresAt).getTime();

  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > tokenRefreshWindowMs) {
    return {
      refreshedToken: null,
      token: tokenCookie,
    };
  }

  const tokenPayload = await refreshLinearToken(tokenCookie, config);
  const refreshedToken = createTokenCookie(tokenPayload, tokenCookie.userId);

  return {
    refreshedToken,
    token: refreshedToken,
  };
}

function createTokenCookie(
  tokenPayload: LinearTokenPayload,
  userId: string,
): LinearOAuthTokenCookie {
  const now = Date.now();
  const expiresAt = new Date(now + tokenPayload.expiresIn * 1000).toISOString();

  return {
    kind: "linear-oauth-token",
    accessToken: tokenPayload.accessToken,
    connectedAt: new Date(now).toISOString(),
    expiresAt,
    refreshToken: tokenPayload.refreshToken,
    scope: tokenPayload.scope,
    tokenType: tokenPayload.tokenType,
    userId,
  };
}

function readStateCookie(
  cookies: ReadonlyMap<string, string>,
  secret: string,
): LinearOAuthStateCookie | null {
  const cookieValue = cookies.get(linearStateCookieName);

  if (cookieValue === undefined) {
    return null;
  }

  return parseStateCookie(unsealCookiePayload(cookieValue, secret));
}

function readTokenCookie(
  cookies: ReadonlyMap<string, string>,
  secret: string,
): LinearOAuthTokenCookie | null {
  const cookieValue = cookies.get(linearTokenCookieName);

  if (cookieValue === undefined) {
    return null;
  }

  return parseTokenCookie(unsealCookiePayload(cookieValue, secret));
}

function parseStateCookie(value: unknown): LinearOAuthStateCookie | null {
  if (!isJsonRecord(value) || value["kind"] !== "linear-oauth-state") {
    return null;
  }

  const state = readString(value, "state");
  const codeVerifier = readString(value, "codeVerifier");
  const createdAt = readString(value, "createdAt");
  const redirectUri = readString(value, "redirectUri");
  const returnTo = readString(value, "returnTo");
  const userId = readString(value, "userId");

  if (
    state === null ||
    codeVerifier === null ||
    createdAt === null ||
    redirectUri === null ||
    returnTo === null ||
    userId === null
  ) {
    return null;
  }

  return {
    kind: "linear-oauth-state",
    codeVerifier,
    createdAt,
    redirectUri,
    returnTo,
    state,
    userId,
  };
}

function parseTokenCookie(value: unknown): LinearOAuthTokenCookie | null {
  if (!isJsonRecord(value) || value["kind"] !== "linear-oauth-token") {
    return null;
  }

  const accessToken = readString(value, "accessToken");
  const refreshToken = readString(value, "refreshToken");
  const tokenType = readString(value, "tokenType");
  const expiresAt = readString(value, "expiresAt");
  const connectedAt = readString(value, "connectedAt");
  const userId = readString(value, "userId");
  const scope = readStringArray(value["scope"]);

  if (
    accessToken === null ||
    refreshToken === null ||
    tokenType === null ||
    expiresAt === null ||
    connectedAt === null ||
    userId === null
  ) {
    return null;
  }

  return {
    kind: "linear-oauth-token",
    accessToken,
    connectedAt,
    expiresAt,
    refreshToken,
    scope,
    tokenType,
    userId,
  };
}

function sealCookiePayload(
  payload: LinearOAuthStateCookie | LinearOAuthTokenCookie,
  secret: string,
): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map(toBase64Url).join(".");
}

function unsealCookiePayload(value: string, secret: string): unknown | null {
  const parts = value.split(".");
  const iv = parts[0];
  const authTag = parts[1];
  const encrypted = parts[2];

  if (iv === undefined || authTag === undefined || encrypted === undefined || parts.length !== 3) {
    return null;
  }

  try {
    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(authTag, "base64url"));
    const decoded = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(decoded);

    return parsed;
  } catch {
    return null;
  }
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function parseCookies(cookieHeader: string | null): ReadonlyMap<string, string> {
  if (cookieHeader === null) {
    return new Map<string, string>();
  }

  const cookies = new Map<string, string>();

  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const rawName = segment.slice(0, separatorIndex).trim();
    const rawValue = segment.slice(separatorIndex + 1).trim();

    try {
      const name = decodeURIComponent(rawName);
      const value = decodeURIComponent(rawValue);

      if (name.length > 0) {
        cookies.set(name, value);
      }
    } catch {
      continue;
    }
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  request: Request,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `Max-Age=${maxAgeSeconds}`,
    "Path=/api/linear",
    "SameSite=Lax",
  ];

  if (isSecureRequest(request)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function expireCookie(name: string, request: Request): string {
  const parts = [
    `${encodeURIComponent(name)}=`,
    "HttpOnly",
    "Max-Age=0",
    "Path=/api/linear",
    "SameSite=Lax",
  ];

  if (isSecureRequest(request)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");

  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}

function jsonResponse<TBody>(
  body: TBody,
  status = 200,
  setCookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
  });

  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(JSON.stringify(body), {
    headers,
    status,
  });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => typeof item === "string");
}

function readScopeValue(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return readScopeList(value);
  }

  return readStringArray(value);
}
