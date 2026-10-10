/**
 * Requests the contract cannot decode, on every route of the control plane API.
 *
 * Effect answers such a request with an empty `400`, and the failure it reports (to the request
 * log, every `ErrorReporter` and the request's tracing span) quotes the rejected input: `Expected
 * array, got "<argv>"`, a whole body that arrived wrapped in an array, `JSON.parse`'s excerpt of a
 * malformed body. A request body can carry a process's arguments, a script or a credential, so
 * `RequestRefusal`, applied to the whole API, answers `400` `RequestRefusedError` instead, with a
 * reason that names where the request is wrong and never what it held. `describeRequestIssue` words
 * that reason from the decode issue alone: field names the contract declares, array positions, and
 * what was expected; a key the caller chose (an `env` or `metadata` name) reads `[…]`.
 */
import { Option, Schema, SchemaAST, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

export class RequestRefusedError extends Schema.TaggedErrorClass<RequestRefusedError>()(
  "RequestRefusedError",
  {
    /** Where the request is wrong and what was expected; never a value it held. */
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/** Applied to every endpoint of `ControlPlaneAPI`: see the module comment. */
export class RequestRefusal extends HttpApiMiddleware.Service<RequestRefusal>()(
  "@sealant/api-contracts/RequestRefusal",
  { error: RequestRefusedError },
) {}

/** The reason for a body that is not JSON at all (`JSON.parse` failed). */
export const REQUEST_BODY_NOT_JSON = "the request body is not valid JSON";

const MAX_REASONS = 3;

interface Reason {
  readonly path: string;
  readonly message: string;
}

const expectedOf = (ast: SchemaAST.AST): string | undefined => {
  if (SchemaAST.isString(ast)) return "a string";
  if (SchemaAST.isNumber(ast)) return "a number";
  if (SchemaAST.isBoolean(ast)) return "a boolean";
  if (SchemaAST.isArrays(ast)) return "an array";
  if (SchemaAST.isObjects(ast)) return "an object";
  if (SchemaAST.isNull(ast)) return "null";
  if (SchemaAST.isUndefined(ast)) return undefined;
  if (SchemaAST.isUnion(ast)) {
    // The JSON codec widens some types into unions (a number also takes "NaN" and "Infinity"):
    // what the members expect, the fixed values said only when nothing else is.
    const kinds = [...new Set(ast.types.map(expectedOf))].filter(
      (kind): kind is string => kind !== undefined,
    );
    const open = kinds.filter((kind) => kind !== "one of the allowed values");
    return (open.length > 0 ? open : kinds).join(" or ") || undefined;
  }
  return "one of the allowed values";
};

const stringAnnotation = (annotations: unknown, key: string): string | undefined => {
  if (typeof annotations !== "object" || annotations === null || !(key in annotations)) {
    return undefined;
  }
  const value: unknown = Reflect.get(annotations, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * A schema author's own words for a failed check, unless they quote the rejected value (a guard
 * against a future check that interpolates its input; no check in the contract does today).
 */
const authoredMessage = (message: string | undefined, actual: unknown): string | undefined => {
  if (message === undefined) return undefined;
  if (typeof actual === "string" && actual.length >= 3 && message.includes(actual)) {
    return undefined;
  }
  return message;
};

/** A path segment: a declared field by name, a position by index, anything else as `[…]`. */
const segment = (key: PropertyKey, parent: SchemaAST.AST | undefined): string => {
  if (typeof key === "number") return `[${key}]`;
  const declared =
    parent !== undefined &&
    SchemaAST.isObjects(parent) &&
    parent.propertySignatures.some((signature) => signature.name === key);
  return declared && typeof key === "string" ? `.${key}` : "[…]";
};

const leaf = (path: string, message: string): Reason[] => [{ path, message }];

const reasonsOf = (
  issue: SchemaIssue.Issue,
  path: string,
  parent: SchemaAST.AST | undefined,
): Reason[] => {
  if (issue instanceof SchemaIssue.Composite) {
    return issue.issues.flatMap((inner) => reasonsOf(inner, path, issue.ast));
  }
  if (issue instanceof SchemaIssue.Pointer) {
    const at = issue.path.reduce<string>((acc, key) => acc + segment(key, parent), path);
    return reasonsOf(issue.issue, at, undefined);
  }
  if (issue instanceof SchemaIssue.Encoding) {
    return reasonsOf(issue.issue, path, parent);
  }
  if (issue instanceof SchemaIssue.AnyOf) {
    return issue.issues.length === 0
      ? leaf(path, `must be ${expectedOf(issue.ast) ?? "one of the allowed values"}`)
      : issue.issues.flatMap((inner) => reasonsOf(inner, path, parent));
  }
  if (issue instanceof SchemaIssue.Filter) {
    const inner =
      issue.issue instanceof SchemaIssue.InvalidValue
        ? stringAnnotation(issue.issue.annotations, "message")
        : undefined;
    const message = authoredMessage(
      inner ?? stringAnnotation(issue.filter.annotations, "message"),
      issue.actual,
    );
    if (message !== undefined) return leaf(path, message);
    const expected = stringAnnotation(issue.filter.annotations, "expected");
    if (expected !== undefined) return leaf(path, `must be ${expected}`);
    return issue.issue instanceof SchemaIssue.InvalidValue
      ? leaf(path, "is invalid")
      : reasonsOf(issue.issue, path, parent);
  }
  if (issue instanceof SchemaIssue.InvalidType) {
    return leaf(path, `must be ${expectedOf(issue.ast) ?? "present"}`);
  }
  if (issue instanceof SchemaIssue.MissingKey) return leaf(path, "is required");
  if (issue instanceof SchemaIssue.InvalidValue) {
    const actual = Option.getOrUndefined(issue.actual);
    return leaf(
      path,
      authoredMessage(stringAnnotation(issue.annotations, "message"), actual) ?? "is invalid",
    );
  }
  if (issue instanceof SchemaIssue.OneOf) return leaf(path, "matches more than one allowed shape");
  return leaf(path, "is not allowed");
};

/**
 * Why a request part (`body`, `query`, `path parameters`, `headers`) cannot be decoded, from its
 * decode issue: up to three places, each with what was expected. Never a value the request held.
 */
export const describeRequestIssue = (part: string, issue: SchemaIssue.Issue): string => {
  const reasons = reasonsOf(issue, "", undefined);
  const shown = reasons.slice(0, MAX_REASONS).map(({ path, message }) => {
    const where = path === "" ? `the request ${part}` : path.replace(/^\./, "");
    // A check that names its own position (`argv[1] contains a NUL byte`) needs no prefix.
    return message.startsWith(where) ? message : `${where} ${message}`;
  });
  const more = reasons.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; ");
};
