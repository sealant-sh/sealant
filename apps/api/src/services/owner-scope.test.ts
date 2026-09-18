import { describe, expect, it } from "vitest";

import { resolveOwnerScope, scopeAdmits } from "./owner-scope.js";

describe("owner scope (CORE-03)", () => {
  it("is the named owner, and admits only that owner's resources", () => {
    const scope = resolveOwnerScope("usr_a", true);
    expect(scope).toEqual({ kind: "owner", ownerUserId: "usr_a" });
    expect(scopeAdmits(scope, "usr_a")).toBe(true);
    expect(scopeAdmits(scope, "usr_b")).toBe(false);
  });

  it("is missing when no owner is named, and admits nothing", () => {
    for (const asserted of [undefined, "", "   "]) {
      const scope = resolveOwnerScope(asserted, true);
      expect(scope).toEqual({ kind: "missing" });
      expect(scopeAdmits(scope, "usr_a")).toBe(false);
    }
  });

  it("is unscoped only on an install that turned the requirement off", () => {
    const scope = resolveOwnerScope(undefined, false);
    expect(scope).toEqual({ kind: "unscoped" });
    expect(scopeAdmits(scope, "usr_a")).toBe(true);
    // A named owner is still held to, requirement or not.
    expect(scopeAdmits(resolveOwnerScope("usr_a", false), "usr_b")).toBe(false);
  });
});
