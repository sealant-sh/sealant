/**
 * Pure helpers for the inference route — separated for unit tests.
 */

/**
 * Strips secret material from text that might flow into logs or error responses. Applied to every
 * engine error message: token values must never leave the process, even inside diagnostics.
 */
export const redactSecret = (text: string, secret: string): string =>
  secret.length === 0 ? text : text.split(secret).join("[redacted]");

/** {@link redactSecret} over several secrets (e.g. a session file's access AND refresh tokens). */
export const redactSecrets = (text: string, secrets: readonly (string | undefined)[]): string =>
  secrets.reduce<string>(
    (accumulated, secret) =>
      secret === undefined ? accumulated : redactSecret(accumulated, secret),
    text,
  );

/** Every string in a JSON value redacted, an object's property names included. */
export const redactStrings = (value: unknown, redact: (text: string) => string): unknown => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactStrings(item, redact)]),
    );
  }
  return value;
};

const HOST_SETTINGS = new Set([
  "PATH",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * A provider CLI's environment, built from nothing: the host's path, temp dir, locale and proxy
 * settings, then `own`. Nothing else the API process holds reaches the CLI: not its secrets, not a
 * switch to a cloud provider's identity, not another base URL or header.
 */
export const providerCliEnv = (own: Readonly<Record<string, string>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (HOST_SETTINGS.has(name) || name.startsWith("LC_"))) {
      env[name] = value;
    }
  }
  return { ...env, ...own };
};

export const soundsLikeAuthFailure = (message: string): boolean =>
  /authentication_failed|invalid api key|oauth token|401|unauthorized|token.*(expired|revoked)/i.test(
    message,
  );

/**
 * Best-effort JSON extraction from a model's final text for the schema-less `responseFormat: json`
 * path (with a schema the agent SDK's native structured output is used instead). Tolerates markdown
 * fences and leading/trailing prose around a single JSON value.
 */
export const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to a bracket scan
  }
  const start = unfenced.search(/[[{]/);
  if (start === -1) {
    return undefined;
  }
  const openChar = unfenced[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = unfenced.lastIndexOf(closeChar);
  if (end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
};
