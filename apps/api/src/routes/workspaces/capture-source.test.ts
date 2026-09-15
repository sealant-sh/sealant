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
          harnessHome: "/workspace/harness-home",
          platform: "cloudflare",
        },
      },
    });
    expect(blueprint.sources.workspace).toEqual({
      kind: "capture",
      endpoint: "https://mend.example.com/session",
      worktreeId: "wt_1",
      harnessHome: "/workspace/harness-home",
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
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session",
            worktreeId: "",
          },
        },
      }),
    ).toThrow();
  });

  it.each([
    ["relative/path", /must be absolute/],
    [" /workspace/harness-home", /leading or trailing whitespace/],
    ["/workspace/harness-home/", /must be normalized/],
    ["/workspace//harness-home", /must be normalized/],
    ["/workspace/../harness-home", /must not contain/],
    ["/workspace/harness\u0000-home", /control characters/],
    ["/", /filesystem root/],
  ])("refuses malformed capture harness home %j", (harnessHome, message) => {
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.com/session",
            harnessHome,
          },
        },
      }),
    ).toThrow(message);
  });

  it("refuses harnessHome on source kinds that do not support capture state", () => {
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        sources: {
          workspace: {
            kind: "git",
            url: "https://github.com/example/repo.git",
            harnessHome: "/workspace/harness-home",
          },
        },
      }),
    ).toThrow(/harnessHome/);
  });

  it("accepts a standby executor that names no worktree yet", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: { workspace: { kind: "capture", endpoint: "https://mend.example.com/session" } },
    });
    expect(blueprint.sources.workspace).toEqual({
      kind: "capture",
      endpoint: "https://mend.example.com/session",
    });
    if (blueprint.sources.workspace.kind !== "capture") {
      throw new Error("expected capture source");
    }
    expect(blueprint.sources.workspace.harnessHome).toBeUndefined();
  });

  it("leaves legacy kind-less payloads resolving as git", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: { workspace: { url: "https://github.com/example/repo.git" } },
    });
    expect(blueprint.sources.workspace.kind).toBe("git");
  });
});
