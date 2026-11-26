/**
 * How each exported span reads in Sentry.
 *
 * Sentry (Relay 26.11) gives a span received over OTLP its `span.op` from `sentry.op`, or derives
 * one from `http.request.method`, `db.system.name` or `messaging.system`, and otherwise calls it
 * `default`. Its `span.description` comes from `sentry.description`, else from a template per op
 * (for `db` the raw `db.query.text`), else it stays empty. Effect's own spans carry none of these,
 * so without this module every application span arrives as `default` with no description, and a
 * database span's description is a 30-column statement that Relay's default scrubber replaces with
 * `[Filtered]` whenever a column name contains `secret`, `auth` or `token`. (`db.query.text` is
 * scrubbed by default rules; `sentry.description` only by rules a person writes.)
 *
 * {@link sentryAttributes} decides, from a span's name, kind and final attributes, the attributes
 * that make it read as an operation and a short description. {@link sentryShapedTracer} applies
 * them as each span ends, and collapses Drizzle's empty `drizzle.operation` wrapper so a
 * statement's span hangs directly off the code that ran it.
 */
import { Option, Tracer } from "effect";

/** The attributes Sentry reads for a span's operation and description. */
export interface SentrySpanAttributes {
  readonly "sentry.op": string;
  readonly "sentry.description": string;
  readonly [key: string]: string;
}

/** What one SQL statement does and to which table, for its span's description. */
export interface SqlSummary {
  /** `SELECT`, `INSERT`, `UPDATE`, `DELETE`, ... upper-cased. */
  readonly operation: string;
  /** The main table, without schema or quotes, when the statement names one. */
  readonly collection: string | undefined;
  /** `SELECT workspace_sessions`; the operation alone when there is no table. */
  readonly summary: string;
}

const KEYWORD = /^[a-z]+/i;
const IDENTIFIER =
  /^(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*))*/i;
const FUNCTION_CALL = /^([a-z_][a-z0-9_]*)\s*\(/i;
const MAIN_OPERATIONS: ReadonlySet<string> = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);

/** The last part of a possibly schema-qualified, possibly quoted identifier. */
const tableName = (identifier: string): string => {
  const parts = identifier.split(/\s*\.\s*/);
  const last = parts.at(-1) ?? identifier;
  return last.startsWith('"') ? last.slice(1, -1).replaceAll('""', '"') : last;
};

/**
 * Each word of `sql` outside quotes, string literals and comments, with its offset and the depth of
 * parentheses it sits at.
 */
const topLevelWords = (sql: string): Array<{ word: string; at: number; depth: number }> => {
  const words: Array<{ word: string; at: number; depth: number }> = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"') {
      const close = sql.indexOf(char, index + 1);
      index = close === -1 ? sql.length : close + 1;
    } else if (char === "-" && sql[index + 1] === "-") {
      const close = sql.indexOf("\n", index);
      index = close === -1 ? sql.length : close + 1;
    } else if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (char === "(") {
      depth += 1;
      index += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (/[a-z_]/i.test(char) && (index === 0 || !/[a-z0-9_$]/i.test(sql[index - 1] ?? ""))) {
      const word = KEYWORD.exec(sql.slice(index))?.[0] ?? char;
      words.push({ word: word.toUpperCase(), at: index, depth });
      index += word.length;
    } else {
      index += 1;
    }
  }
  return words;
};

/** The identifier that starts at `at` in `sql`, after whitespace. */
const identifierAt = (sql: string, at: number): string | undefined => {
  const rest = sql.slice(at).trimStart();
  const match = IDENTIFIER.exec(rest)?.[0];
  return match === undefined ? undefined : tableName(match);
};

/**
 * What `sql` does and to which table. Reads only keywords and identifiers, never literals, so a
 * statement with inlined values yields no more than its shape.
 */
export const summarizeSql = (sql: string): SqlSummary | undefined => {
  const words = topLevelWords(sql);
  const first = words[0];
  if (first === undefined) return undefined;
  // A CTE's main statement is the first top-level SELECT/INSERT/UPDATE/DELETE after its bodies.
  const main =
    first.word === "WITH"
      ? words.find((word) => word.depth === 0 && MAIN_OPERATIONS.has(word.word))
      : first;
  if (main === undefined)
    return { operation: first.word, collection: undefined, summary: first.word };
  const operation = main.word;
  const after = words.filter((word) => word.at > main.at && word.depth === main.depth);
  // The table after `keyword` at the statement's own depth; past a subquery (`FROM (SELECT ...)`),
  // the first table any `keyword` names.
  const following = (keyword: string): string | undefined => {
    const tableAfter = (word: { word: string; at: number }) =>
      word.word === keyword ? identifierAt(sql, word.at + keyword.length) : undefined;
    for (const word of after) {
      const table = tableAfter(word);
      if (table !== undefined) return table;
    }
    for (const word of words) {
      const table = word.at > main.at ? tableAfter(word) : undefined;
      if (table !== undefined) return table;
    }
    return undefined;
  };
  let collection: string | undefined;
  switch (operation) {
    case "SELECT":
      collection = following("FROM");
      break;
    case "INSERT":
      collection = following("INTO");
      break;
    case "UPDATE":
      collection = identifierAt(sql, main.at + operation.length);
      break;
    case "DELETE":
      collection = following("FROM");
      break;
    default:
      collection = undefined;
  }
  if (collection === undefined && operation === "SELECT") {
    // `SELECT set_config(...)`: name the function the statement calls.
    const called = FUNCTION_CALL.exec(sql.slice(main.at + operation.length).trimStart())?.[1];
    if (called !== undefined) {
      return { operation, collection: undefined, summary: `${operation} ${called.toLowerCase()}` };
    }
  }
  return {
    operation,
    collection,
    summary: collection === undefined ? operation : `${operation} ${collection}`,
  };
};

// A path segment that names one record rather than a route: a prefixed ID (`sess_01J…`,
// `ws_3f…`), a UUID, a number, or a long run of hex or base64url.
const ID_SEGMENT =
  /^(?:[a-z][a-z0-9]{0,15}_[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

/** `path` with each segment that names a record replaced by `*`, as Sentry groups them. */
export const templatePath = (path: string): string =>
  path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(decodeURIComponentSafe(segment)) ? "*" : segment))
    .join("/");

const decodeURIComponentSafe = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const snakeCase = (identifier: string): string =>
  identifier.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The record IDs a request names, read by matching its `route` template against its `path`:
 * `/v1/sessions/:sessionId/output` and `/v1/sessions/sess_1/output` give
 * `sealant.session_id=sess_1`. Only parameters named `...Id` count, so a free-text segment (a
 * file path, a branch name) is never copied.
 */
export const routeIdAttributes = (route: string, path: string): Record<string, string> => {
  const routeSegments = route.split("/");
  const pathSegments = path.split("/");
  if (routeSegments.length !== pathSegments.length) return {};
  const ids: Record<string, string> = {};
  routeSegments.forEach((segment, index) => {
    const value = pathSegments[index];
    if (!segment.startsWith(":") || value === undefined || value === "") return;
    const parameter = segment.slice(1);
    if (parameter.length > 2 && parameter.endsWith("Id")) {
      ids[`sealant.${snakeCase(parameter)}`] = decodeURIComponentSafe(value);
    }
  });
  return ids;
};

const stringAttribute = (
  attributes: ReadonlyMap<string, unknown>,
  key: string,
): string | undefined => {
  const value = attributes.get(key);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

// `sealant.workspace.create` -> `sealant.workspace`: the product and area of a span named by the
// telemetry contract (`<product>.<area>.<operation>`).
const CONTRACT_NAME = /^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\.[a-z0-9_.]+$/;

/**
 * The Sentry attributes for a span that ended with `name`, `kind` and `attributes`. Attributes the
 * span already set itself (an explicit `sentry.op` or `sentry.description`) are kept.
 */
export const sentryAttributes = (
  name: string,
  kind: Tracer.SpanKind,
  attributes: ReadonlyMap<string, unknown>,
): Record<string, string> => {
  const explicitOp = stringAttribute(attributes, "sentry.op");
  const explicitDescription = stringAttribute(attributes, "sentry.description");
  const method = stringAttribute(attributes, "http.request.method");
  const dbSystem = stringAttribute(attributes, "db.system.name");
  const shaped: Record<string, string> = {};

  if (dbSystem !== undefined) {
    const query = stringAttribute(attributes, "db.query.text");
    const summary = query === undefined ? undefined : summarizeSql(query);
    shaped["sentry.op"] = explicitOp ?? "db";
    // The legacy name some Sentry views still group by.
    shaped["db.system"] = dbSystem;
    if (summary !== undefined) {
      shaped["db.operation.name"] = summary.operation;
      if (summary.collection !== undefined) shaped["db.collection.name"] = summary.collection;
      shaped["db.query.summary"] = summary.summary;
    }
    shaped["sentry.description"] =
      explicitDescription ?? summary?.summary ?? `${dbSystem} ${name}`.trim();
    return keepExplicit(shaped, attributes);
  }

  if (name === "sql.transaction") {
    shaped["sentry.op"] = explicitOp ?? "db.sql.transaction";
    shaped["sentry.description"] = explicitDescription ?? "transaction";
    return keepExplicit(shaped, attributes);
  }

  if (method !== undefined && (kind === "server" || kind === "client")) {
    if (kind === "server") {
      const route = stringAttribute(attributes, "http.route");
      const path = stringAttribute(attributes, "url.path");
      shaped["sentry.op"] = explicitOp ?? "http.server";
      // An unmatched request has no route: describe it by its templated path, never its IDs.
      shaped["sentry.description"] =
        explicitDescription ??
        `${method} ${route ?? (path === undefined ? "" : templatePath(path))}`.trim();
      if (route !== undefined && path !== undefined) {
        Object.assign(shaped, routeIdAttributes(route, path));
      }
      return keepExplicit(shaped, attributes);
    }
    shaped["sentry.op"] = explicitOp ?? "http.client";
    if (explicitDescription === undefined) {
      const template = stringAttribute(attributes, "url.template");
      const path = stringAttribute(attributes, "url.path");
      const host = stringAttribute(attributes, "server.address");
      const where = template ?? (path === undefined ? undefined : templatePath(path)) ?? host ?? "";
      shaped["sentry.description"] = `${method} ${where}`.trim();
      if (template === undefined && path !== undefined) {
        shaped["url.template"] = templatePath(path);
      }
    }
    return keepExplicit(shaped, attributes);
  }

  const messaging = stringAttribute(attributes, "messaging.system");
  if (messaging !== undefined && (kind === "consumer" || kind === "producer")) {
    shaped["sentry.op"] = explicitOp ?? (kind === "consumer" ? "queue.process" : "queue.publish");
    shaped["sentry.description"] =
      explicitDescription ?? stringAttribute(attributes, "messaging.destination.name") ?? name;
    return keepExplicit(shaped, attributes);
  }

  shaped["sentry.op"] = explicitOp ?? CONTRACT_NAME.exec(name)?.[1] ?? "function";
  shaped["sentry.description"] = explicitDescription ?? name;
  return keepExplicit(shaped, attributes);
};

/** `shaped` without the keys the span set itself. */
const keepExplicit = (
  shaped: Record<string, string>,
  attributes: ReadonlyMap<string, unknown>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(shaped).filter(([key]) => !attributes.has(key)));

/** Drizzle's wrapper around each statement it runs: no attributes of its own, never exported. */
const PASS_THROUGH_SPANS: ReadonlySet<string> = new Set(["drizzle.operation"]);

/**
 * A span that stands in for `parent` and records nothing: a span started beneath it is a child of
 * `parent`, and it exports nothing itself.
 */
const passThrough = (
  name: string,
  parent: Tracer.AnySpan,
  options: {
    readonly annotations: Tracer.Span["annotations"];
    readonly kind: Tracer.SpanKind;
    readonly startTime: bigint;
  },
): Tracer.Span => {
  let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
  return {
    _tag: "Span",
    name,
    spanId: parent.spanId,
    traceId: parent.traceId,
    parent: "parent" in parent ? parent.parent : Option.none(),
    annotations: options.annotations,
    get status() {
      return status;
    },
    attributes: new Map(),
    links: [],
    sampled: parent.sampled,
    kind: options.kind,
    end: (endTime, exit) => {
      status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
    },
    attribute: () => undefined,
    event: () => undefined,
    addLinks: () => undefined,
  };
};

/**
 * `tracer`, setting each span's Sentry attributes ({@link sentryAttributes}) as it ends, and
 * passing Drizzle's `drizzle.operation` wrapper through to its parent.
 */
export const sentryShapedTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      if (PASS_THROUGH_SPANS.has(options.name) && Option.isSome(options.parent)) {
        return passThrough(options.name, options.parent.value, options);
      }
      const span = tracer.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        try {
          for (const [key, value] of Object.entries(
            sentryAttributes(span.name, span.kind, span.attributes),
          )) {
            span.attribute(key, value);
          }
        } catch {
          // Shaping is presentation only: a span is exported as it is rather than lost.
        }
        end(endTime, exit);
      };
      return span;
    },
  });
