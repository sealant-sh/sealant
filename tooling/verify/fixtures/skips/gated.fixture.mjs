// A suite gated the way sealant's database suites are: it skips itself without its variable.
import { describe, expect, it } from "vitest";

it("always runs", () => {
  expect(1 + 1).toBe(2);
});

describe.skipIf(process.env.VERIFY_FIXTURE_GATE === undefined)("gated", () => {
  it("runs only with VERIFY_FIXTURE_GATE", () => {
    expect(process.env.VERIFY_FIXTURE_GATE).toBe("on");
  });
});
