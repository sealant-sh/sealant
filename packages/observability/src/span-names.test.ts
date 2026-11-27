/**
 * Every span sealant makes reads as an operation in Sentry: `sealant.<area>.<operation>` in lower
 * snake case, never a function's, class's or helper's name, and each described by a short phrase
 * no other span shares.
 *
 * This reads the source of every app and package, finds each call that names a span (`Effect.fn`,
 * `withSpan`, `useSpan`, `makeSpan`, `makeSpanScoped`) and holds every name it finds, with the
 * description Sentry will show for it, to that convention. A new span with a name like
 * `syncBackClaudeCredentials` or `sealant.session.with_high_water` fails here. HTTP and SQL spans are
 * named as they end (`sentry-span.ts`), so they never appear in source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { CONTRACT_NAME, describeSpanName } from "./sentry-span.js";
import { SPAN_DESCRIPTIONS } from "./span-descriptions.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Source that ships: tests, end-to-end suites, fixtures and declarations make no spans in production. */
const NOT_SHIPPED = /\.(?:test|e2e|fixture|spec)\.tsx?$|\.d\.ts$/;

/** The calls that start a span named by an argument. `Effect.fn` without a name starts none. */
const SPAN_CALLS: ReadonlySet<string> = new Set([
  "withSpan",
  "useSpan",
  "makeSpan",
  "makeSpanScoped",
]);

/** Names that tracers give library spans as they start (`sentry-span.ts`). */
const LIBRARY_SPAN_NAMES: readonly string[] = ["sealant.db.query", "sealant.db.transaction"];

/** Words that name code rather than what it does, anywhere in a name. */
const CODE_WORDS: ReadonlySet<string> = new Set([
  "engine",
  "fn",
  "handler",
  "helper",
  "impl",
  "repo",
  "service",
]);
/** Words a function's name starts with (`with_high_water`, `require_owned`), not an operation's. */
const CODE_PREFIXES: ReadonlySet<string> = new Set(["do", "maybe", "require", "with"]);
/** Words a function's name ends with (`target_for`, `views_of`, `run_once`, `install_if_needed`). */
const CODE_SUFFIXES: ReadonlySet<string> = new Set(["as", "for", "needed", "of", "once", "with"]);

/**
 * Span names made from a value at run time, by the file and template that make them: each gives
 * the names the template can produce, read from the same source.
 */
const TEMPLATED: Readonly<Record<string, (source: (file: string) => string) => string[]>> = {
  // `sealant.daemon.<operation>` for each operation but `connect`, which has its own span.
  "packages/workspaces/src/sealantd/runtime.ts|sealant.daemon.${}": (source) =>
    stringArray(source("packages/workspaces/src/sealantd/runtime.ts"), "sealantOperationSchema")
      .filter((operation) => operation !== "connect")
      .map(
        (operation) =>
          `sealant.daemon.${operation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
      ),
};

/**
 * Span names the source passes in a variable, by file: `@sealant/sdk` names each call's span from
 * the API contract (`sealant.sdk.<group>.<endpoint>`); its own tests hold those names.
 */
const PASSED_IN: ReadonlySet<string> = new Set(["packages/sdk/src/effect/trace.ts"]);

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const children = (node: AstNode): AstNode[] =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );

const walk = (node: AstNode, visit: (node: AstNode) => void): void => {
  visit(node);
  for (const child of children(node)) walk(child, visit);
};

const stringLiteral = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const identifierName = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

const parse = (file: string, source: string): AstNode => {
  const { program } = parseSync(file, source);
  if (!isNode(program)) throw new Error(`${file}: no program`);
  return program;
};

/** The strings in the array literal `name` is declared with in `source` (or passed to a call in it). */
const stringArray = (source: string, name: string): string[] => {
  const found: string[] = [];
  walk(parse("source.ts", source), (node) => {
    if (node.type !== "VariableDeclarator" || identifierName(node.id) !== name) return;
    walk(node, (inner) => {
      if (inner.type !== "ArrayExpression" || !Array.isArray(inner.elements)) return;
      for (const element of inner.elements) {
        const value = stringLiteral(element);
        if (value !== undefined) found.push(value);
      }
    });
  });
  if (found.length === 0) throw new Error(`no string array named ${name}`);
  return found;
};

/** One span name found in source. */
interface FoundName {
  readonly name: string;
  readonly at: string;
}

/** What one file names its spans: literal names, templates, and names passed in a variable. */
const spanNamesIn = (
  file: string,
  source: string,
): {
  readonly names: FoundName[];
  readonly templates: FoundName[];
  readonly passed: FoundName[];
} => {
  const program = parse(file, source);
  const constants = new Map<string, string>();
  walk(program, (node) => {
    const name = identifierName(node.id);
    const value = stringLiteral(node.init);
    if (node.type === "VariableDeclarator" && name !== undefined && value !== undefined) {
      constants.set(name, value);
    }
  });
  const lineOf = (node: AstNode) =>
    typeof node.start === "number" ? source.slice(0, node.start).split("\n").length : 0;
  const names: FoundName[] = [];
  const templates: FoundName[] = [];
  const passed: FoundName[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" || !isNode(node.callee)) return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.computed === true) return;
    const method = identifierName(callee.property);
    const isFn = method === "fn" && identifierName(callee.object) === "Effect";
    if (!isFn && (method === undefined || !SPAN_CALLS.has(method))) return;
    const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
    const at = `${file}:${lineOf(node)}`;
    // `withSpan(name, options)` piped, or `withSpan(effect, name, options)` data first.
    for (const arg of isFn ? args.slice(0, 1) : args.slice(0, 2)) {
      const literal = stringLiteral(arg) ?? constants.get(identifierName(arg) ?? "");
      if (literal !== undefined) {
        names.push({ name: literal, at });
        return;
      }
      if (arg.type === "TemplateLiteral" && Array.isArray(arg.quasis)) {
        const text = arg.quasis
          .filter(isNode)
          .map((quasi) => {
            const value: unknown = quasi.value;
            return typeof value === "object" &&
              value !== null &&
              "raw" in value &&
              typeof value.raw === "string"
              ? value.raw
              : "";
          })
          .join("${}");
        templates.push({ name: text, at });
        return;
      }
    }
    // `Effect.fn(function* ...)` names no span.
    if (isFn) return;
    passed.push({ name: "", at });
  });
  return { names, templates, passed };
};

/** Every shipped TypeScript file under `apps/` and `packages/`, relative to the repository. */
const sourceFiles = (): string[] => {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.tsx?$/.test(entry.name) && !NOT_SHIPPED.test(entry.name)) {
        files.push(relative(ROOT, path));
      }
    }
  };
  for (const top of ["apps", "packages"]) visit(join(ROOT, top));
  return files;
};

const readSource = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** Every span name sealant's source makes, where it is made, and what could not be read. */
const inventory = () => {
  const names: FoundName[] = [];
  const unread: string[] = [];
  for (const file of sourceFiles()) {
    const found = spanNamesIn(file, readSource(file));
    names.push(...found.names);
    for (const template of found.templates) {
      const expand = TEMPLATED[`${file}|${template.name}`];
      if (expand === undefined) unread.push(`${template.at}: templated name \`${template.name}\``);
      else names.push(...expand(readSource).map((name) => ({ name, at: template.at })));
    }
    if (!PASSED_IN.has(file)) {
      for (const call of found.passed) unread.push(`${call.at}: span name passed in a variable`);
    }
  }
  return { names, unread };
};

/** What is wrong with `name` as a span name, or `undefined` when nothing is. */
const nameProblem = (name: string): string | undefined => {
  const match = CONTRACT_NAME.exec(name);
  if (match === null) return "not `sealant.<area>.<operation>` in lower snake case";
  const [, product = "", area = "", operation = ""] = match;
  if (product !== "sealant") return `product \`${product}\`, not \`sealant\``;
  if (operation.includes(".")) return "more than three parts";
  const words = operation.split("_");
  const codeWord =
    [...area.split("_"), ...words].find((word) => CODE_WORDS.has(word)) ??
    (CODE_PREFIXES.has(words[0] ?? "") ? words[0] : undefined) ??
    (CODE_SUFFIXES.has(words.at(-1) ?? "") ? words.at(-1) : undefined);
  if (codeWord !== undefined) return `\`${codeWord}\` names code, not an operation`;
  return undefined;
};

/** What is wrong with `description` as the description of `name`, or `undefined`. */
const descriptionProblem = (name: string, description: string): string | undefined => {
  if (!/^[a-z]+:?(?: [a-z]+:?){1,4}$/.test(description)) {
    return `"${description}" is not two to five lower-case words`;
  }
  const last = name.split(".").at(-1)?.split("_").at(-1);
  if (description === last) return `"${description}" is only the name's last word`;
  return undefined;
};

describe("sealant's span names", () => {
  const { names, unread } = inventory();
  const distinct = [...new Set(names.map((found) => found.name))].toSorted();

  it("are all read from source", () => {
    expect(unread).toEqual([]);
    // A walker that found nothing would pass everything below.
    expect(distinct.length).toBeGreaterThan(100);
    expect(distinct).toEqual(
      expect.arrayContaining([
        "sealant.workspace.create",
        "sealant.job.process",
        "sealant.daemon.open_session",
        "sealant.daemon.connect",
      ]),
    );
  });

  it("each name an operation: `sealant.<area>.<operation>`", () => {
    const problems = names.flatMap((found) => {
      const problem = nameProblem(found.name);
      return problem === undefined ? [] : [`${found.name} (${found.at}): ${problem}`];
    });
    expect(problems).toEqual([]);
  });

  it("each described by a short phrase no other name shares", () => {
    const byDescription = new Map<string, string[]>();
    const problems: string[] = [];
    for (const name of [...distinct, ...LIBRARY_SPAN_NAMES]) {
      const description = describeSpanName(name)?.description ?? "";
      const problem = descriptionProblem(name, description);
      if (problem !== undefined) problems.push(`${name}: ${problem}`);
      byDescription.set(description, [...(byDescription.get(description) ?? []), name]);
    }
    for (const [description, shared] of byDescription) {
      if (shared.length > 1) problems.push(`"${description}" describes ${shared.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("describe only spans that exist", () => {
    const known = new Set([...distinct, ...LIBRARY_SPAN_NAMES]);
    expect(Object.keys(SPAN_DESCRIPTIONS).filter((name) => !known.has(name))).toEqual([]);
  });
});

describe("the span name check", () => {
  it("finds names in every call that starts a span, including multi-line and data-first calls", () => {
    const source = [
      `const SPAN = "sealant.job.process";`,
      `export const a = Effect.fn("syncBackClaudeCredentials")(function* () {});`,
      `export const b = Effect.fn(\n  "sealant.session.with_high_water",\n)(function* () {});`,
      `export const c = (effect) => Effect.withSpan(effect, "BoatAccountRepo.list", {});`,
      `export const d = effect.pipe(Effect.withSpan(SPAN));`,
      `export const e = Effect.useSpan(\`sealant.daemon.\${op}\`, {}, f);`,
      `export const f = Effect.fn(function* () {});`,
      `export const g = (name) => Effect.withSpan(effect, name);`,
    ].join("\n");
    const found = spanNamesIn("example.ts", source);
    expect(found.names.map((item) => item.name)).toEqual([
      "syncBackClaudeCredentials",
      "sealant.session.with_high_water",
      "BoatAccountRepo.list",
      "sealant.job.process",
    ]);
    expect(found.templates.map((item) => item.name)).toEqual(["sealant.daemon.${}"]);
    expect(found.passed).toHaveLength(1);
  });

  it("refuses names that are code, and descriptions that say nothing", () => {
    expect(nameProblem("syncBackClaudeCredentials")).toBeDefined();
    expect(nameProblem("BoatAccountRepo.list")).toBeDefined();
    expect(nameProblem("sealant.session.with_high_water")).toBeDefined();
    expect(nameProblem("sealant.credential.target_for")).toBeDefined();
    expect(nameProblem("sealant.workspace.require_owned")).toBeDefined();
    expect(nameProblem("mend.session.start")).toBeDefined();
    expect(nameProblem("sealant.workspace.create")).toBeUndefined();
    expect(descriptionProblem("sealant.daemon.connect", "connect")).toBeDefined();
    expect(descriptionProblem("sealant.workspace.exec", "exec")).toBeDefined();
    expect(descriptionProblem("sealant.workspace.create", "create workspace")).toBeUndefined();
    expect(
      descriptionProblem("sealant.daemon.open_session", "call daemon: open session"),
    ).toBeUndefined();
  });
});
