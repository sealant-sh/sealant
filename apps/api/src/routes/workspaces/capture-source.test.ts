import { parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Shape pins for the `capture` workspace source (sealantd ADR-0015): a session channel endpoint
 * and a worktree id, no host path, and — deliberately — no credential. The token travels once
 * through the secret env channel (`captureToken` on the create request), never in the blueprint.
 */
const baseSpec = { harness: { id: "claude-code" } };

describe("blueprint capture source", () => {
  it("parses endpoint, worktree id and the optional platform hint", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session",
          worktreeId: "wt_1",
          platform: "cloudflare",
        },
      },
    });
    expect(blueprint.sources.workspace).toEqual({
      kind: "capture",
      endpoint: "https://mend.example.com/session",
      worktreeId: "wt_1",
      platform: "cloudflare",
    });
    expect(blueprint.sources.mounts).toEqual([]);
  });

  it("refuses a token in the blueprint and a malformed endpoint", () => {
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session",
            worktreeId: "wt_1",
            token: "mst_secret",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        sources: { workspace: { kind: "capture", endpoint: "not a url", worktreeId: "wt_1" } },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        sources: { workspace: { kind: "capture", endpoint: "https://mend.example.com/session" } },
      }),
    ).toThrow();
  });

  it("leaves legacy kind-less payloads resolving as git", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: { workspace: { url: "https://github.com/example/repo.git" } },
    });
    expect(blueprint.sources.workspace.kind).toBe("git");
  });
});
