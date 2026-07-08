import { describe, expect, it } from "vitest";

import { SealantError } from "../errors.js";
import { parseTtlSeconds } from "./duration.js";

describe("parseTtlSeconds", () => {
  it("parses each supported unit into whole seconds", () => {
    expect(parseTtlSeconds("45s")).toBe(45);
    expect(parseTtlSeconds("90m")).toBe(5400);
    expect(parseTtlSeconds("2h")).toBe(7200);
    expect(parseTtlSeconds("1d")).toBe(86400);
  });

  it("rounds milliseconds up to at least one second", () => {
    expect(parseTtlSeconds("1500ms")).toBe(2);
    expect(parseTtlSeconds("10ms")).toBe(1);
  });

  it("rejects malformed durations with a typed error", () => {
    for (const bad of ["", "2", "h", "2 h", "-2h", "2.5h", "2w", "soon"]) {
      expect(() => parseTtlSeconds(bad), bad).toThrowError(SealantError);
    }
  });
});
