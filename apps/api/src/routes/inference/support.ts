/**
 * Pure helpers for the inference route — separated for unit tests.
 */

/**
 * Strips secret material from text that might flow into logs or error responses. Applied to every
 * engine error message: token values must never leave the process, even inside diagnostics.
 */
export const redactSecret = (text: string, secret: string): string =>
  secret.length === 0 ? text : text.split(secret).join("[redacted]");

/** Auth-shaped engine failures mark the connected account invalid (401-feedback, design doc §2). */
export const isAuthFailureMessage = (message: string): boolean =>
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
