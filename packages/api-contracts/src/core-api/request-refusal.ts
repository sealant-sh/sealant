/**
 * Requests the contract cannot decode, on every route of the control plane API.
 *
 * Effect answers such a request with an empty `400`. Before Effect 4.0.0, the failure it reports (to
 * the request log, every `ErrorReporter` and the request's tracing span) quoted the rejected input:
 * `Expected array, got "<argv>"`, a whole body that arrived wrapped in an array, `JSON.parse`'s
 * excerpt of a malformed body; Effect 4 reports input only to a parse that asks for it. A request
 * body can carry a process's arguments, a script or a credential, so `RequestRefusal`, applied to
 * the whole API, answers `400` `RequestRefusedError` instead, with a reason that names where the
 * request is wrong and never what it held, and Effect's failure goes no further.
 *
 * `describeRequestIssue` words that reason from the decode issue alone, and says only words that
 * existed before the request did: field names the contract declares, array positions, what the
 * schema expected (`expected` and `message` annotations, set when the contract is built), and its
 * own wording. A key the caller chose (an `env` or `metadata` name) reads `[…]`. Text a check
 * returns while decoding is said only when the check declared it up front (`refusal-words.ts`):
 * that text is computed from the value, so whether it quotes the value cannot be told from the text
 * itself. Anything else reads "is invalid". The rule does not depend on where Effect keeps the
 * rejected value, which it does not report at all to a parse that does not ask (SLNT-960).
 */
import { Schema, SchemaAST, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

import { REFUSAL_WORDS, type RefusalWord } from "./refusal-words.js";

export class RequestRefusedError extends Schema.TaggedError<RequestRefusedError>()(
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

/** A check's declared words (`refusal-words.ts`), or none. */
const declaredWords = (annotations: unknown): ReadonlyArray<RefusalWord> => {
  if (typeof annotations !== "object" || annotations === null) return [];
  const words: unknown = Reflect.get(annotations, REFUSAL_WORDS);
  return Array.isArray(words)
    ? words.filter(
        (word: unknown): word is RefusalWord => typeof word === "string" || word instanceof RegExp,
      )
    : [];
};

const matchesWhole = (pattern: RegExp, text: string): boolean => {
  const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(text);
  return match !== null && match.index === 0 && match[0].length === text.length;
};

/** Text a check returned while decoding, when it is one of the words the check declared. */
const declared = (
  text: string | undefined,
  words: ReadonlyArray<RefusalWord>,
): string | undefined =>
  text !== undefined &&
  words.some((word) => (typeof word === "string" ? word === text : matchesWhole(word, text)))
    ? text
    : undefined;

/**
 * A path segment: a field its object declares by name, a position in an array by index, anything
 * else (a key the caller chose, a path a check built) as `[…]`.
 */
const segment = (key: PropertyKey, parent: SchemaAST.AST | undefined): string => {
  if (typeof key === "number") {
    return parent !== undefined && SchemaAST.isArrays(parent) ? `[${key}]` : "[…]";
  }
  const named =
    typeof key === "string" &&
    parent !== undefined &&
    SchemaAST.isObjects(parent) &&
    parent.propertySignatures.some((signature) => signature.name === key);
  return named ? `.${key}` : "[…]";
};

const leaf = (path: string, message: string): Reason[] => [{ path, message }];

/**
 * `words` are those the nearest check declared: text inside its issue is said only when it is one
 * of them. A transformation declares none.
 */
const reasonsOf = (
  issue: SchemaIssue.Issue,
  path: string,
  parent: SchemaAST.AST | undefined,
  words: ReadonlyArray<RefusalWord>,
): Reason[] => {
  if (issue instanceof SchemaIssue.Composite) {
    return issue.issues.flatMap((inner) => reasonsOf(inner, path, issue.ast, words));
  }
  if (issue instanceof SchemaIssue.Pointer) {
    const at = issue.path.reduce<string>((acc, key) => acc + segment(key, parent), path);
    return reasonsOf(issue.issue, at, undefined, words);
  }
  if (issue instanceof SchemaIssue.Encoding) {
    return reasonsOf(issue.issue, path, parent, []);
  }
  if (issue instanceof SchemaIssue.AnyOf) {
    return issue.issues.length === 0
      ? leaf(path, `must be ${expectedOf(issue.ast) ?? "one of the allowed values"}`)
      : issue.issues.flatMap((inner) => reasonsOf(inner, path, parent, words));
  }
  if (issue instanceof SchemaIssue.Filter) {
    const { annotations } = issue.filter;
    const own = declaredWords(annotations);
    const returned =
      issue.issue instanceof SchemaIssue.InvalidValue
        ? declared(stringAnnotation(issue.issue.annotations, "message"), own)
        : undefined;
    const message = returned ?? stringAnnotation(annotations, "message");
    if (message !== undefined) return leaf(path, message);
    const expected = stringAnnotation(annotations, "expected");
    if (expected !== undefined) return leaf(path, `must be ${expected}`);
    // The check's own path is the check's to choose: its keys read `[…]`.
    return issue.issue instanceof SchemaIssue.InvalidValue
      ? leaf(path, "is invalid")
      : reasonsOf(issue.issue, path, undefined, own);
  }
  if (issue instanceof SchemaIssue.InvalidType) {
    return leaf(path, `must be ${expectedOf(issue.ast) ?? "present"}`);
  }
  if (issue instanceof SchemaIssue.MissingKey) return leaf(path, "is required");
  if (issue instanceof SchemaIssue.InvalidValue) {
    return leaf(
      path,
      declared(stringAnnotation(issue.annotations, "message"), words) ?? "is invalid",
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
  const reasons = reasonsOf(issue, "", undefined, []);
  const shown = reasons.slice(0, MAX_REASONS).map(({ path, message }) => {
    const where = path === "" ? `the request ${part}` : path.replace(/^\./, "");
    // A check that names its own position (`argv[1] contains a NUL byte`) needs no prefix.
    return message.startsWith(where) ? message : `${where} ${message}`;
  });
  const more = reasons.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; ");
};
