import { parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Shape pins for `sources.mounts` — the ADDITIONAL caller-owned binds beside the primary source.
 * The blueprint carries shape only (read-only default, normalized absolute paths); allowlist and
 * working-directory-overlap policy live in the workspaces module, which sees the resolved runtime
 * defaults.
 */
const baseSpec = {
  sources: { workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" } },
  harness: { id: "claude-code" },
};

describe("blueprint sources.mounts", () => {
  it("defaults to an empty list when absent", () => {
    const blueprint = parseWorkspaceBlueprint(baseSpec);
    expect(blueprint.sources.mounts).toEqual([]);
  });

  it("defaults each mount to read-only", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: {
        ...baseSpec.sources,
        mounts: [{ hostPath: "/srv/store/_references/effect", mountPath: "/workspace/ref/effect" }],
      },
    });
    expect(blueprint.sources.mounts).toEqual([
      {
        hostPath: "/srv/store/_references/effect",
        mountPath: "/workspace/ref/effect",
        readOnly: true,
      },
    ]);
  });

  it("keeps an explicit read-write choice", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      sources: {
        ...baseSpec.sources,
        mounts: [
          { hostPath: "/srv/store/scratch", mountPath: "/workspace/home/scratch", readOnly: false },
        ],
      },
    });
    expect(blueprint.sources.mounts[0]?.readOnly).toBe(false);
  });

  it("rejects unnormalized paths on either side", () => {
    const withMount = (mount: Record<string, unknown>) => ({
      ...baseSpec,
      sources: { ...baseSpec.sources, mounts: [mount] },
    });
    expect(() =>
      parseWorkspaceBlueprint(
        withMount({ hostPath: "relative/path", mountPath: "/workspace/ref/x" }),
      ),
    ).toThrow(/host path must be absolute/);
    expect(() =>
      parseWorkspaceBlueprint(
        withMount({ hostPath: "/srv/store/../etc", mountPath: "/workspace/ref/x" }),
      ),
    ).toThrow(/host path must not contain/);
    expect(() =>
      parseWorkspaceBlueprint(withMount({ hostPath: "/srv/store/x", mountPath: "ref/x" })),
    ).toThrow(/mount path must be absolute/);
    expect(() =>
      parseWorkspaceBlueprint(withMount({ hostPath: "/srv/store/x", mountPath: "/" })),
    ).toThrow(/mount path must not be the filesystem root/);
  });

  it("git-sourced workspaces may carry extra mounts", () => {
    const blueprint = parseWorkspaceBlueprint({
      sources: {
        workspace: { kind: "git", url: "https://github.com/example/repo.git" },
        mounts: [{ hostPath: "/srv/store/_references/effect", mountPath: "/workspace/ref/effect" }],
      },
      harness: { id: "claude-code" },
    });
    expect(blueprint.sources.workspace.kind).toBe("git");
    expect(blueprint.sources.mounts).toHaveLength(1);
  });
});
