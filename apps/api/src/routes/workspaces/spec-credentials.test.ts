import { newWorkspaceSchema, parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Regression pin for the create-path invariant: the payload schema accepts a
 * `credentials` convenience key, the worker's blueprint schema strictly
 * rejects it, and the workspaces module must therefore strip it after
 * lowering into `runtime.credentialRefs`. Keeping the key killed every
 * mount+credentials build at `parseWorkspaceBlueprint` on 0.7.0.
 */
const specWithCredentials = {
  sources: { workspace: { kind: "mount", hostPath: "/home/user/.mend/store/repo/worktrees/s1" } },
  harness: { id: "claude-code" },
  credentials: { claude: "default" },
};

describe("create-payload credentials vs the worker blueprint", () => {
  it("the payload schema accepts the credentials key", () => {
    const parsed = newWorkspaceSchema.parse(specWithCredentials);
    expect(parsed.credentials).toEqual({ claude: "default" });
  });

  it("the blueprint schema rejects the same spec while the key is present", () => {
    expect(() => parseWorkspaceBlueprint(specWithCredentials)).toThrow(/credentials/);
  });

  it("stripping the key — what the module does after resolving refs — makes the spec buildable", () => {
    const resolved: Record<string, unknown> = newWorkspaceSchema.parse(specWithCredentials);
    delete resolved["credentials"];
    const blueprint = parseWorkspaceBlueprint(resolved);
    expect(blueprint.sources.workspace.kind).toBe("mount");
  });
});
