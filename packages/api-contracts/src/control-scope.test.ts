import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CONTROL_SCOPE_PROBLEMS, controlScopeProblem } from "./control-scope.js";
import { createWorkspaceRequestSchema } from "./core-api/workspaces.js";

describe("controlScopeProblem", () => {
  it("takes one path segment a caller mints", () => {
    for (const scope of ["mend-exec-1", "0", "a.b_c-d", "x".repeat(128)]) {
      expect(controlScopeProblem(scope)).toBeUndefined();
    }
  });

  it("refuses anything that could name a path other than one directory of the control root", () => {
    // Each of these would resolve outside the scope's own directory, or name no directory.
    for (const scope of ["", ".", "..", "../x", "a/b", "/abs", ".hidden", "_dotfiles", "A1"]) {
      expect(controlScopeProblem(scope)).toBe(CONTROL_SCOPE_PROBLEMS.shape);
    }
    expect(controlScopeProblem("x".repeat(129))).toBe(CONTROL_SCOPE_PROBLEMS.shape);
  });

  it("refuses sealant's own directories: another executor's scope or a proxy's admin directory", () => {
    for (const scope of ["sealant", "sealant-run-1", "sealant-vm-run-1", "sealant-run-1-proxy"]) {
      expect(controlScopeProblem(scope)).toBe(CONTROL_SCOPE_PROBLEMS.reserved);
    }
  });

  it("is the rule a create's controlScope is decoded by", () => {
    const create = (controlScope: string) =>
      Schema.decodeUnknownExit(createWorkspaceRequestSchema)({
        ownerUserId: "user_1",
        registryId: "local",
        repository: "demo",
        tag: "latest",
        spec: {},
        controlScope,
      });
    expect(Exit.isSuccess(create("mend-exec-1"))).toBe(true);
    expect(Exit.isFailure(create("sealant-run-1-proxy"))).toBe(true);
  });
});
