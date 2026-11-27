/**
 * What a page-load or navigation transaction keeps before it is sent: the spans that say something
 * about the page. The hashed static bundle (`/assets/*` scripts, styles and fonts) loads on every
 * page and is served from cache after the first, so a span per file buries the route's own requests
 * under dozens of near-identical rows. A file that took long to load is kept: that is a finding.
 * Outgoing requests are described by their templated path, never the IDs in it. A page load or
 * navigation is named by its URL template, not its route ID.
 */
import type { Event } from "@sentry/react";

/** A static file slower than this keeps its span. */
export const SLOW_ASSET_SECONDS = 1;

const STATIC_ASSET = /^(?:https?:\/\/[^/]+)?\/assets\//;

// A path segment that names one record: a prefixed ID (`ws_3f…`), a UUID, a number, or a long run
// of hex or base64url.
const ID_SEGMENT =
  /^(?:[a-z][a-z0-9]{0,15}_[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

/** `url` with each path segment that names one record replaced by `*`. */
export const templateUrlPath = (url: string): string => {
  const match = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*)?([^?#]*)(.*)$/i.exec(url);
  if (match === null) return url;
  const [, origin = "", path = "", rest = ""] = match;
  const templated = path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? "*" : segment))
    .join("/");
  return `${origin}${templated}${rest}`;
};

type SpanJson = NonNullable<Event["spans"]>[number];

const isQuietAsset = (span: SpanJson): boolean => {
  if (span.op?.startsWith("resource.") !== true) return false;
  if (span.description === undefined || !STATIC_ASSET.test(span.description)) return false;
  const seconds = span.timestamp === undefined ? 0 : span.timestamp - span.start_timestamp;
  return seconds < SLOW_ASSET_SECONDS;
};

const tidySpan = (span: SpanJson): SpanJson => {
  if (span.op !== "http.client" || span.description === undefined) return span;
  const [method, ...url] = span.description.split(" ");
  if (method === undefined || url.length === 0) return span;
  return { ...span, description: `${method} ${templateUrlPath(url.join(" "))}` };
};

/** `event` without its quiet static-file spans, its requests described by templated paths. */
export const tidyTransaction = <E extends Event>(event: E): E =>
  event.spans === undefined
    ? event
    : { ...event, spans: event.spans.filter((span) => !isQuietAsset(span)).map(tidySpan) };

/** The URL template `fullPath` reads as: `/workspaces/` is `/workspaces`, and `/` stays `/`. */
export const urlTemplate = (fullPath: string): string =>
  fullPath.length > 1 && fullPath.endsWith("/") ? fullPath.slice(0, -1) : fullPath;

/**
 * `event` named by its page's URL template (`/workspaces/$workspaceId`). Sentry's TanStack Router
 * integration names a page load or navigation by the matched route's ID, which spells out pathless
 * layouts and index routes (`/_authenticated/workspaces/`) that no one sees in the address bar.
 * `templateOf` gives a route ID's URL template, or `undefined` for a name that is not a route ID.
 */
export const nameByUrlTemplate = <E extends Event>(
  event: E,
  templateOf: (routeId: string) => string | undefined,
): E => {
  const trace = event.contexts?.trace;
  if (trace?.op !== "pageload" && trace?.op !== "navigation") return event;
  const template = event.transaction === undefined ? undefined : templateOf(event.transaction);
  if (template === undefined) return event;
  return {
    ...event,
    transaction: template,
    contexts: {
      ...event.contexts,
      trace: { ...trace, data: { ...trace.data, "url.template": template } },
    },
  };
};
