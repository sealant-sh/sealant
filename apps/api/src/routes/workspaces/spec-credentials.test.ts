import { newWorkspaceSchema, parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Why the create path must strip the key: the payload schema accepts a
 * `credentials` convenience key and the worker's blueprint schema strictly
 * rejects it. That the module strips it after lowering into
 * `runtime.credentialRefs` is proven through `createWorkspace` in
 * capture-source-create.test.ts. Keeping the key killed every
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
});
