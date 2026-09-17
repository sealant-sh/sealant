/**
 * Credentials go only where they were issued for (CORE-05).
 *
 * Two credentials leave the control plane for a destination the caller names: a GitHub
 * installation token, sent to the clone URL, and the capture session token, sent to the session
 * channel endpoint. Both destinations are checked here, at create, before anything is sealed,
 * minted or queued. These are pure functions; `client-authrefs.ts` and `workspaces.module.ts`
 * apply them.
 *
 * What this does not do: contain code running in a workspace. A harness can dial anything the
 * executor's network lets it reach, so egress isolation stays the runtime's job (the chart's
 * workspace NetworkPolicy, the MicroVM connector).
 */

/** The web host repositories are cloned from, derived from the API base the install talks to. */
export const gitHubWebHostOf = (apiBaseUrl: string): string => {
  const host = new URL(apiBaseUrl).host.toLowerCase();
  // github.com serves its API from a sibling host; GitHub Enterprise Server serves it under /api.
  return host === "api.github.com" ? "github.com" : host;
};

/**
 * The `owner/name` a clone URL addresses on `webHost`, or null when the URL is anything but
 * `https://<webHost>/<owner>/<name>[.git]`: another host, plain HTTP, embedded credentials, a
 * port, a query, a fragment, extra path segments or a dot segment.
 */
export const gitHubRepositoryOfUrl = (
  url: string,
  webHost: string,
): { readonly owner: string; readonly name: string } | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.host.toLowerCase() !== webHost.toLowerCase()) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  // The raw string, not `pathname`: URL parsing has already collapsed `..`, decoded nothing it
  // should not, and turned `\` into `/` by this point. None of the three belongs in a clone URL.
  if (url.includes("..") || url.includes("%") || url.includes("\\")) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const [owner, rawName] = segments;
  if (owner === undefined || rawName === undefined) return null;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;
  const component = /^[A-Za-z0-9._-]+$/;
  if (!component.test(owner) || !component.test(name) || name.length === 0) return null;
  return { owner, name };
};

/** Whether the URL is the repository the installation token was issued for. */
export const urlIsInstallationRepository = (input: {
  readonly url: string;
  readonly webHost: string;
  readonly owner: string;
  readonly name: string;
}): boolean => {
  const addressed = gitHubRepositoryOfUrl(input.url, input.webHost);
  return (
    addressed !== null &&
    addressed.owner.toLowerCase() === input.owner.toLowerCase() &&
    addressed.name.toLowerCase() === input.name.toLowerCase()
  );
};

const isLoopbackHost = (hostname: string): boolean => {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
};

/** `SEALANT_CAPTURE_ALLOWED_ENDPOINTS`: comma-separated origins; null when the list is malformed. */
export const parseAllowedCaptureOrigins = (
  raw: string | undefined,
): ReadonlyArray<string> | null => {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const origins: Array<string> = [];
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return null;
    }
    const bare = parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
    if (!bare || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
    origins.push(parsed.origin);
  }
  return origins;
};

/**
 * Why the capture token may not be sent to this endpoint, or null when it may. The daemon
 * enforces the same transport rules at boot (sealantd ADR-0015 "Transport"); refusing here turns
 * a workspace that would die at boot into a 4xx that says what to change.
 */
export const captureDestinationRefusal = (input: {
  readonly endpoint: string;
  readonly plaintext: boolean;
  /** Origins the operator approved; empty means the operator set no list. */
  readonly allowedOrigins: ReadonlyArray<string>;
  /** The operator's veto on plain HTTP, whatever the launcher states. */
  readonly refusePlaintext: boolean;
}): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(input.endpoint);
  } catch {
    return "The capture endpoint is not a URL.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The capture endpoint must be an http(s) URL.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "The capture endpoint must not embed credentials; the session token travels separately.";
  }
  if (input.allowedOrigins.length > 0 && !input.allowedOrigins.includes(parsed.origin)) {
    return `The capture endpoint's origin (${parsed.origin}) is not in SEALANT_CAPTURE_ALLOWED_ENDPOINTS.`;
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    if (input.refusePlaintext) {
      return "This install refuses plain-HTTP capture endpoints (SEALANT_CAPTURE_REFUSE_PLAINTEXT): serve the session channel over https.";
    }
    if (!input.plaintext) {
      return "The capture endpoint is plain http. Serve it over https, or state that the network between the executor and the channel is private with source.transport.plaintext = true.";
    }
  }
  if (input.plaintext && input.refusePlaintext) {
    return "This install refuses source.transport.plaintext (SEALANT_CAPTURE_REFUSE_PLAINTEXT).";
  }
  return null;
};
