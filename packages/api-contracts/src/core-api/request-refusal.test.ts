import { Effect, Result, Schema, SchemaGetter, SchemaIssue } from "effect";
import { describe, expect, it } from "vitest";

import { EndpointUrl } from "./endpoint-url.js";
import { refusalWords } from "./refusal-words.js";
import { describeRequestIssue } from "./request-refusal.js";
import { resourceInstanceVolumeSchema } from "./resource-instances.js";
import { sessionArgvSchema } from "./sessions.js";

const SECRET = "ghp_secretTokenValue";
/** Pieces of the secrets below, any of which a reason must never hold. */
const PIECES = [SECRET, "secretToken", "TokenValue", "271828", "pin-7c1e9"];

const reason = (
  schema: Schema.Codec<unknown, unknown>,
  input: unknown,
  part: string = "body",
): string => {
  // As the resource domain groups decode a payload (`HttpApi.PayloadParseOptions`).
  const result = Schema.decodeUnknownResult(schema)(input, {
    errors: "all",
    onExcessProperty: "error",
  });
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return describeRequestIssue(part, result.failure.issue);
};

const expectNoPiece = (said: string) => {
  for (const piece of PIECES) expect(said).not.toContain(piece);
};

describe("describeRequestIssue", () => {
  it("names declared fields and positions, and hides a key the caller chose", () => {
    const schema = Schema.Struct({
      commands: Schema.Array(Schema.Struct({ args: Schema.Array(Schema.String) })),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    });
    expect(reason(schema, { commands: [{ args: ["a", { [SECRET]: SECRET }] }] })).toBe(
      "commands[0].args[1] must be a string",
    );
    const hidden = reason(schema, { commands: [], env: { [SECRET]: 5 } });
    expect(hidden).toBe("env[…] must be a string");
    expect(reason(schema, [SECRET])).toBe("the request body must be an object");
    expect(reason(schema, {})).toBe("commands is required");
  });

  it("drops a check's own words when they quote the rejected value", () => {
    const quoting = Schema.Struct({
      token: Schema.String.check(Schema.makeFilter((value: string) => `bad token ${value}`)),
    });
    const said = reason(quoting, { token: SECRET });
    expect(said).not.toContain(SECRET);
    expect(said).toBe("token is invalid");
  });

  it("says how many more places are wrong past the first three", () => {
    const schema = Schema.Struct({
      a: Schema.String,
      b: Schema.String,
      c: Schema.String,
      d: Schema.String,
    });
    expect(reason(schema, {})).toBe("a is required; b is required; c is required; and 1 more");
  });
});

/**
 * Checks that put the value they reject, or a piece of it, in their own words, each with a value it
 * rejects: every way a check or a transformation can hand Effect text built from its input.
 */
const quoting: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>, unknown]> = [
  [
    "a string check's message",
    Schema.String.check(Schema.makeFilter((value: string) => `bad token ${value}`)),
    SECRET,
  ],
  [
    "a piece of the string",
    Schema.String.check(Schema.makeFilter((value: string) => `starts ${value.slice(4, 15)}`)),
    SECRET,
  ],
  [
    "a short value",
    Schema.String.check(Schema.makeFilter((value: string) => `pin ${value} is wrong`)),
    "pin-7c1e9",
  ],
  [
    "a number check's message",
    Schema.Number.check(Schema.makeFilter((value: number) => `pin ${value} is wrong`)),
    271828,
  ],
  [
    "a whole object the check received",
    Schema.Struct({ token: Schema.String }).check(
      Schema.makeFilter((value: { readonly token: string }) => `bad ${JSON.stringify(value)}`),
    ),
    { token: SECRET },
  ],
  [
    "a whole array the check received",
    Schema.Array(Schema.String).check(
      Schema.makeFilter((value: ReadonlyArray<string>) => `bad ${value.join(" ")}`),
    ),
    ["printf", SECRET],
  ],
  [
    "an issue the check built itself",
    Schema.String.check(
      Schema.makeFilter(
        (value: string) => new SchemaIssue.InvalidValue({ message: `bad token ${value}` }),
      ),
    ),
    SECRET,
  ],
  [
    "a path the check built from the value",
    Schema.String.check(Schema.makeFilter((value: string) => ({ path: [value], issue: "bad" }))),
    SECRET,
  ],
  [
    "a numeric path the check built from the value",
    Schema.Number.check(Schema.makeFilter((value: number) => ({ path: [value], issue: "bad" }))),
    271828,
  ],
  [
    "a transformation's failure",
    Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.checkEffect((value: string) => Effect.succeed(`bad token ${value}`)),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    SECRET,
  ],
  [
    "words beyond the ones the check declared",
    Schema.String.check(
      Schema.makeFilter((value: string) => `bad token ${value}`, refusalWords("bad token")),
    ),
    SECRET,
  ],
  [
    "a declared pattern the words match only in part",
    Schema.String.check(
      Schema.makeFilter((value: string) => `bad token ${value}`, refusalWords(/bad token \w/)),
    ),
    SECRET,
  ],
];

/** Where a request can carry a value: [position, schema around the check, input around the value]. */
const positions: ReadonlyArray<
  readonly [
    string,
    (check: Schema.Codec<unknown, unknown>) => Schema.Codec<unknown, unknown>,
    (value: unknown) => unknown,
  ]
> = [
  ["the whole body", (check) => check, (value) => value],
  ["a field's value", (check) => Schema.Struct({ token: check }), (value) => ({ token: value })],
  [
    "an array item",
    (check) => Schema.Struct({ items: Schema.Array(check) }),
    (value) => ({ items: [value] }),
  ],
  [
    "a nested object",
    (check) => Schema.Struct({ outer: Schema.Struct({ inner: check }) }),
    (value) => ({ outer: { inner: value } }),
  ],
  [
    "a value under a key the caller chose",
    (check) => Schema.Record(Schema.String, check),
    (value) => ({ [SECRET]: value }),
  ],
];

describe("a refusal never quotes the value it refused", () => {
  for (const [kind, check, value] of quoting) {
    for (const [position, around, place] of positions) {
      it(`${kind}, in ${position}`, () => {
        const said = reason(around(check), place(value));
        expect(said).toMatch(/is invalid|must be/);
        expectNoPiece(said);
      });
    }
  }

  it("a key the caller chose that a check rejects", () => {
    const keyCheck = Schema.String.check(Schema.makeFilter((key: string) => `bad name ${key}`));
    const said = reason(Schema.Struct({ env: Schema.Record(keyCheck, Schema.String) }), {
      env: { [SECRET]: "x" },
    });
    expect(said).toMatch(/^env\[…\] /);
    expectNoPiece(said);
  });

  for (const part of ["query", "path parameters", "headers"]) {
    it(`a value in the request's ${part}`, () => {
      const schema = Schema.Struct({
        token: Schema.String.check(Schema.makeFilter((value: string) => `bad token ${value}`)),
      });
      const said = reason(schema, { token: SECRET }, part);
      expect(said).toBe("token is invalid");
      expectNoPiece(said);
    });
  }
});

describe("a refusal still says what the contract wrote", () => {
  it("a check's declared words, exactly or matching a declared pattern whole", () => {
    const exact = Schema.String.check(
      Schema.makeFilter(
        (value: string) => (value === "ok" ? undefined : "must be ok"),
        refusalWords("must be ok"),
      ),
    );
    expect(reason(Schema.Struct({ token: exact }), { token: SECRET })).toBe("token must be ok");
    const counted = Schema.Array(Schema.String).check(
      Schema.makeFilter(
        (value: ReadonlyArray<string>) => `has ${value.length} words`,
        refusalWords(/has \d+ words/),
      ),
    );
    expect(reason(Schema.Struct({ argv: counted }), { argv: [SECRET, SECRET] })).toBe(
      "argv has 2 words",
    );
  });

  it("a check's message or expectation, fixed when the contract was built", () => {
    const annotated = Schema.String.check(
      Schema.makeFilter(() => false, { message: "must name a branch" }),
    );
    expect(reason(Schema.Struct({ ref: annotated }), { ref: SECRET })).toBe(
      "ref must name a branch",
    );
    const pattern = Schema.String.check(Schema.isPattern(/^x$/));
    expect(reason(Schema.Struct({ ref: pattern }), { ref: SECRET })).toBe(
      "ref must be a string matching the RegExp ^x$",
    );
  });

  it("the contract's own checks, word for word", () => {
    expect(
      reason(Schema.Struct({ endpoint: EndpointUrl }), {
        endpoint: `https://user:${SECRET}@gateway.example`,
      }),
    ).toBe("endpoint must not carry a user name or password; the key is sent on its own");
    expect(
      reason(Schema.Struct({ argv: sessionArgvSchema }), { argv: ["printf", "a\u0000"] }),
    ).toBe("argv[1] contains a NUL byte, which no process argument can carry");
    expect(reason(Schema.Struct({ argv: sessionArgvSchema }), { argv: [] })).toBe(
      "argv is empty: argv[0] must name the program",
    );
    expect(
      reason(resourceInstanceVolumeSchema, { name: "data", mountPath: `/proc/${SECRET}` }),
    ).toBe("mountPath must not be under /proc, /sys or /dev");
  });
});
