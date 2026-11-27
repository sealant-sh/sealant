/**
 * How each exported span reads in Sentry.
 *
 * Sentry (Relay 26.11) names a transaction, and lists a span, by the span's own name. It gives a
 * span received over OTLP its `span.op` from `sentry.op`, or derives one from
 * `http.request.method`, `db.system.name` or `messaging.system`, and otherwise calls it `default`.
 * Its `span.description` comes from `sentry.description`, else from a template per op (for `db` the
 * raw `db.query.text`), else it stays empty. Its `release` comes from a `sentry.release` attribute
 * on the span itself: the resource's copy is stored as `resource.sentry.release` and fills nothing.
 *
 * Effect names a request's span by its method alone (the route is matched after the span starts)
 * and a statement's span by its database (`postgres`), and its own spans carry none of Sentry's
 * attributes. So {@link shapeSpan} decides, from a span's name, kind and final attributes, the name
 * it is exported under (`GET /v1/runs/:runId`, `SELECT runs`) and the attributes that make it read
 * as an operation with a short description. {@link sentryShapedTracer} applies both as each span
 * ends, adds the release and environment, renames Effect's `sql.transaction`, and passes Drizzle's
 * empty wrappers through so a statement's span hangs directly off the code that ran it.
 *
 * Every other name follows `sealant.<area>.<operation>`; {@link describeSpanName} says what it does
 * in words, from {@link SPAN_DESCRIPTIONS} where the name's own words would not.
 */
import { Option, Tracer } from "effect";

import { SPAN_DESCRIPTIONS } from "./span-descriptions.js";

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

/** A segment a route spells out: a lower-case word (`workspaces`, `exec-as-user`) or a version. */
const ROUTE_WORD = /^(?:v\d+|[a-z]+(?:[-_][a-z]+)*)$/;

/**
 * `path` with every segment that could name a record or carry a code replaced by `*`: anything but
 * a lower-case word or a version. A session ID becomes `*`, and so does a login code
 * (`/api/cli-auth/57TX-M9HG` is `/api/cli-auth/*`). Used for a request no route matched and an
 * outgoing one with no template, so neither a name nor a description holds an ID.
 */
export const templatePath = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      segment === "" || (segment.length <= 32 && ROUTE_WORD.test(segment)) ? segment : "*",
    )
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

/**
 * `sealant.workspace.create` -> `sealant`, `workspace` and `create`: the product, area and
 * operation of a span named by the telemetry contract (`<product>.<area>.<operation>`, lower snake
 * case). An SDK call's operation is `<group>.<endpoint>`.
 */
export const CONTRACT_NAME =
  /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)$/;

/**
 * Areas named for a part of sealant rather than a record: their operations read on their own.
 * Every other area is the noun a one-word operation acts on (`sealant.workspace.create` is "create
 * workspace").
 */
const COMPONENT_AREAS: ReadonlySet<string> = new Set(["inference", "job", "sdk"]);

/** The word a one-word operation takes before its noun, where English needs one. */
const PREPOSITIONS: Readonly<Record<string, string>> = { exec: "in" };

const plural = (noun: string): string =>
  /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : noun.endsWith("s") ? noun : `${noun}s`;

/** `resolve_credential_refs` -> `resolve credential refs`. */
const words = (identifier: string): string => identifier.split(/[_.]+/).filter(Boolean).join(" ");

/**
 * What a contract-named span does, in words, without the op it is shown beside: in Sentry
 * `sealant.workspace.create` reads `sealant.workspace — create workspace`. The description is
 * {@link SPAN_DESCRIPTIONS}' entry for the name; else, for a one-word operation on a record, the
 * operation and its noun; else the operation's words. A call to the daemon reads "call daemon:
 * open session". An SDK call (`sealant.sdk.<group>.<endpoint>`) is described by its endpoint, which
 * already names its record. `undefined` for a name the contract does not shape.
 */
export const describeSpanName = (
  name: string,
): { readonly op: string; readonly description: string } | undefined => {
  const match = CONTRACT_NAME.exec(name);
  if (match === null) return undefined;
  const [, product = "", area = "", operation = ""] = match;
  const op = `${product}.${area}`;
  const listed = SPAN_DESCRIPTIONS[name];
  if (listed !== undefined) return { op, description: listed };
  if (area === "sdk") {
    return { op, description: words(operation.split(".").at(-1) ?? operation) };
  }
  const action = words(operation);
  if (area === "daemon") return { op, description: `call daemon: ${action}` };
  if (COMPONENT_AREAS.has(area) || action.includes(" ")) return { op, description: action };
  const noun = words(area);
  const preposition = PREPOSITIONS[action];
  return {
    op,
    description:
      action === "list"
        ? `list ${plural(noun)}`
        : `${action}${preposition === undefined ? "" : ` ${preposition}`} ${noun}`,
  };
};

/** How a span is exported: its name, and the attributes it gains. */
export interface ShapedSpan {
  /** The span's name in Sentry, which also names the transaction a root span starts. */
  readonly name: string;
  /** Sentry's attributes for it; never one the span set itself. */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * How a span that ended with `name`, `kind` and `attributes` is exported:
 *
 * - a request handled: `<METHOD> <route>`, with an unmatched path templated ({@link templatePath});
 * - a request sent: `<METHOD> <url.template>`, else its templated path, never the host;
 * - a statement: `<OPERATION> <table>` ({@link summarizeSql});
 * - a job delivery or enqueue: its own name, described by its queue;
 * - any other span: its own name, with the op and description {@link describeSpanName} gives it.
 *
 * Attributes the span set itself (an explicit `sentry.op` or `sentry.description`) are kept.
 */
export const shapeSpan = (
  name: string,
  kind: Tracer.SpanKind,
  attributes: ReadonlyMap<string, unknown>,
): ShapedSpan => {
  const explicitOp = stringAttribute(attributes, "sentry.op");
  const explicitDescription = stringAttribute(attributes, "sentry.description");
  const method = stringAttribute(attributes, "http.request.method");
  const dbSystem = stringAttribute(attributes, "db.system.name");
  const described = describeSpanName(name);
  const shaped: Record<string, string> = {};

  // A statement. `sealant.db.transaction` carries the client's `db.system.name` too, and is
  // shaped by its own name below.
  if (dbSystem !== undefined && described === undefined) {
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
    const statement = summary?.summary ?? "QUERY";
    shaped["sentry.description"] = explicitDescription ?? statement;
    return { name: statement, attributes: keepExplicit(shaped, attributes) };
  }

  if (method !== undefined && (kind === "server" || kind === "client")) {
    const path = stringAttribute(attributes, "url.path");
    const templated = path === undefined ? "*" : templatePath(path);
    if (kind === "server") {
      const route = stringAttribute(attributes, "http.route");
      const request = `${method} ${route ?? templated}`;
      shaped["sentry.op"] = explicitOp ?? "http.server";
      shaped["sentry.description"] = explicitDescription ?? request;
      if (route !== undefined && path !== undefined) {
        Object.assign(shaped, routeIdAttributes(route, path));
      }
      return { name: request, attributes: keepExplicit(shaped, attributes) };
    }
    const template = stringAttribute(attributes, "url.template");
    const request = `${method} ${template ?? templated}`;
    shaped["sentry.op"] = explicitOp ?? "http.client";
    shaped["sentry.description"] = explicitDescription ?? request;
    if (template === undefined && path !== undefined) shaped["url.template"] = templated;
    return { name: request, attributes: keepExplicit(shaped, attributes) };
  }

  const messaging = stringAttribute(attributes, "messaging.system");
  if (messaging !== undefined && (kind === "consumer" || kind === "producer")) {
    shaped["sentry.op"] = explicitOp ?? (kind === "consumer" ? "queue.process" : "queue.publish");
    shaped["sentry.description"] =
      explicitDescription ?? stringAttribute(attributes, "messaging.destination.name") ?? name;
    return { name, attributes: keepExplicit(shaped, attributes) };
  }

  shaped["sentry.op"] = explicitOp ?? described?.op ?? "function";
  shaped["sentry.description"] = explicitDescription ?? described?.description ?? name;
  // The span's own name, so code search still finds it from what Sentry shows.
  if (described !== undefined) shaped["code.function.name"] = name;
  return { name, attributes: keepExplicit(shaped, attributes) };
};

/** `shaped` without the keys the span set itself. */
const keepExplicit = (
  shaped: Record<string, string>,
  attributes: ReadonlyMap<string, unknown>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(shaped).filter(([key]) => !attributes.has(key)));

/** Effect's span around each SQL transaction, under the name it is exported as. */
const TRANSACTION_SPAN = "sealant.db.transaction";

/** Library span names, renamed as the span starts. */
const RENAMED_SPANS: Readonly<Record<string, string>> = {
  "sql.transaction": TRANSACTION_SPAN,
  // Drizzle's wrapper around one statement, when no span of ours is above it to stand in for.
  "drizzle.operation": "sealant.db.query",
};

/**
 * Spans Drizzle makes that record nothing a reader needs. Under a parent each stands in for it, so
 * what runs inside hangs off that parent. Without one, `drizzle.operation` is exported as
 * `sealant.db.query`, and the others (the client made at startup) start no trace.
 */
const PASS_THROUGH_SPANS: ReadonlySet<string> = new Set([
  "drizzle.operation",
  "PgDrizzle.make",
  "EffectLogger.logQuery",
]);

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

/** What every span of the process carries, so Sentry files it under its release. */
export interface SpanShapingOptions {
  readonly release?: string | undefined;
  readonly environment?: string | undefined;
}

/**
 * `tracer`, exporting each span under the name and attributes {@link shapeSpan} gives it, with
 * `sentry.release` and `sentry.environment` from `options`, and passing Drizzle's empty wrappers
 * through to their parent.
 */
export const sentryShapedTracer = (
  tracer: Tracer.Tracer,
  options: SpanShapingOptions = {},
): Tracer.Tracer => {
  const common: Record<string, string> = {
    ...(options.release === undefined ? {} : { "sentry.release": options.release }),
    ...(options.environment === undefined ? {} : { "sentry.environment": options.environment }),
  };
  return Tracer.make({
    ...tracer,
    span: (spanOptions) => {
      const parent = spanOptions.root ? Option.none() : spanOptions.parent;
      if (PASS_THROUGH_SPANS.has(spanOptions.name) && Option.isSome(parent)) {
        return passThrough(spanOptions.name, parent.value, spanOptions);
      }
      const renamed = RENAMED_SPANS[spanOptions.name];
      const span = tracer.span({
        ...spanOptions,
        name: renamed ?? spanOptions.name,
        sampled:
          spanOptions.sampled &&
          (renamed !== undefined || !PASS_THROUGH_SPANS.has(spanOptions.name)),
      });
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        try {
          const shaped = shapeSpan(span.name, span.kind, span.attributes);
          for (const [key, value] of Object.entries({ ...common, ...shaped.attributes })) {
            if (!span.attributes.has(key)) span.attribute(key, value);
          }
          // SAFETY: Effect's tracers keep a span's name in a plain field that the exporter reads
          // when the span ends; `readonly` only stops callers from changing it. A span whose name
          // cannot be set (`Reflect.set` returns false) is exported under the name it started with.
          if (shaped.name !== span.name) Reflect.set(span, "name", shaped.name);
        } catch {
          // Shaping is presentation only: a span is exported as it is rather than lost.
        }
        end(endTime, exit);
      };
      return span;
    },
  });
};
