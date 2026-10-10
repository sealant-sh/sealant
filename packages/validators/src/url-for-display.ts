/**
 * A configured URL as it may be shown (a startup log line, an API response): its `user:password@`
 * and the values of its credential query parameters read `REDACTED`. Configuration URLs may carry a
 * credential (`REGISTRY_BASE_URL=https://user:token@registry`, a `?token=` on an API endpoint); the
 * process keeps using the URL as given, and only what it prints or returns is redacted.
 */

const REDACTED = "REDACTED";

/** Query parameter names whose values are credentials, compared without case. */
const CREDENTIAL_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "ticket",
  "code",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
]);

/** `value` with userinfo and credential query parameters redacted; not a URL: a placeholder. */
export const urlForDisplay = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL, so not known to be free of a credential.
    return "[not a URL]";
  }
  if (url.username !== "" || url.password !== "") {
    url.username = REDACTED;
    url.password = REDACTED;
  }
  // A copy of the names: values are rewritten while they are walked.
  for (const name of Array.from(url.searchParams.keys())) {
    if (CREDENTIAL_QUERY_PARAMETERS.has(name.toLowerCase())) url.searchParams.set(name, REDACTED);
  }
  return url.toString();
};

/**
 * `value` split into the URL to request (no userinfo) and the userinfo it carried, decoded. `fetch`
 * refuses a URL with userinfo, quoting the whole URL, credential included, in its error; a client
 * sends the userinfo as its Basic credential instead.
 */
export const splitUrlUserinfo = (
  value: string,
): { readonly url: URL; readonly username?: string; readonly password?: string } => {
  const url = new URL(value);
  if (url.username === "" && url.password === "") return { url };
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return { url, username, password };
};
