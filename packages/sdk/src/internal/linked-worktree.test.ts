import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { SealantError } from "../errors.js";
import { discoverLinkedWorktreeMetadataMount } from "./linked-worktree.js";

const withTempDirectory = <A>(run: (directory: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), "sealant-linked-worktree-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const fixture = (root: string, pointer: "absolute" | "relative") => {
  const repository = join(root, "repo.git");
  const worktree = join(root, "worktrees", "session-1");
  const gitDirectory = join(repository, "worktrees", "session-1");
  mkdirSync(gitDirectory, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(gitDirectory, "commondir"), "../..\n");
  writeFileSync(
    join(worktree, ".git"),
    `gitdir: ${pointer === "absolute" ? gitDirectory : relative(worktree, gitDirectory)}\n`,
  );
  return { repository, worktree };
};

describe("discoverLinkedWorktreeMetadataMount", () => {
  it("binds an absolute linked-worktree common directory at the path the pointer names", () =>
    withTempDirectory((root) => {
      const { repository, worktree } = fixture(root, "absolute");

      expect(discoverLinkedWorktreeMetadataMount(worktree)).toEqual({
        hostPath: repository,
        mountPath: repository,
        readOnly: false,
      });
    }));

  it("resolves relative gitdir and commondir pointers", () =>
    withTempDirectory((root) => {
      const { repository, worktree } = fixture(root, "relative");

      expect(discoverLinkedWorktreeMetadataMount(worktree)?.hostPath).toBe(repository);
    }));

  it("adds nothing for a normal repository whose .git directory is already mounted", () =>
    withTempDirectory((root) => {
      const repository = join(root, "repository");
      mkdirSync(join(repository, ".git"), { recursive: true });

      expect(discoverLinkedWorktreeMetadataMount(repository)).toBeNull();
    }));

  it("adds nothing for a non-Git mount source", () =>
    withTempDirectory((root) => {
      expect(discoverLinkedWorktreeMetadataMount(root)).toBeNull();
    }));

  it("fails before workspace creation when a linked-worktree pointer is broken", () =>
    withTempDirectory((root) => {
      writeFileSync(join(root, ".git"), "gitdir: /does/not/exist\n");

      expect(() => discoverLinkedWorktreeMetadataMount(root)).toThrowError(
        expect.objectContaining<Partial<SealantError>>({
          code: "mount_source_git_metadata_invalid",
        }),
      );
    }));
});
