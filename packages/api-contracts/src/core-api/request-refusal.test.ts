import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { describeRequestIssue } from "./request-refusal.js";

const SECRET = "ghp_secretTokenValue";

const reason = (schema: Schema.Codec<unknown, unknown>, input: unknown): string => {
  const result = Schema.decodeUnknownResult(schema)(input);
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return describeRequestIssue("body", result.failure.issue);
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
    const all = Schema.decodeUnknownResult(schema)({}, { errors: "all" });
    if (!Result.isFailure(all)) throw new Error("expected a refusal");
    expect(describeRequestIssue("body", all.failure.issue)).toBe(
      "a is required; b is required; c is required; and 1 more",
    );
  });
});
