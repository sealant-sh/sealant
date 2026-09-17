import {
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  type GitHubInstallationRepoService,
  type GitHubInstallationRepositoryCacheRepoService,
} from "@sealant/db";
import { newWorkspaceSchema } from "@sealant/validators";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { validateClientSuppliedAuthRefs } from "./client-authrefs.js";

/**
 * The worker turns `sources.*.authRef` into real capability: the GitHub namespace mints an
 * installation token with no grant check of its own, and any other value is passed to
 * `docker build --secret src=<value>` as a host file path. These tests pin the API-side gate
 * that makes both unreachable for refs the caller made up.
 */

const specWithDotfilesAuthRef = (authRef: string, url = "https://github.com/o/dots.git") =>
  newWorkspaceSchema.parse({
    sources: {
      workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" },
      inputs: [
        {
          id: "dotfiles-test",
          purpose: "dotfiles",
          url,
          authRef,
        },
      ],
    },
    harness: { id: "claude-code" },
  });

const installationRepositoryRecord = {
  id: "ghrepo_1",
  installationId: "ghinst_1",
  repositoryId: "repo_1",
  owner: "o",
  name: "dots",
  fullName: "o/dots",
  defaultBranch: "main",
  removedAt: null,
};

const stubLayers = (overrides: {
  readonly record?: typeof installationRepositoryRecord | undefined;
  readonly installationStatus?: string;
  readonly hasGrant?: boolean;
}) => {
  const installations = {
    getInstallationById: (_id: string) =>
      Effect.succeed({
        id: "ghinst_1",
        status: overrides.installationStatus ?? "active",
      }),
    userHasInstallationGrant: (_input: { installationId: string; userId: string }) =>
      Effect.succeed(overrides.hasGrant ?? true),
  } as unknown as GitHubInstallationRepoService;
  const installationRepositories = {
    getInstallationRepositoryById: (_id: string) =>
      Effect.succeed("record" in overrides ? overrides.record : installationRepositoryRecord),
  } as unknown as GitHubInstallationRepositoryCacheRepoService;
  return Layer.mergeAll(
    Layer.succeed(GitHubInstallationRepo, installations),
    Layer.succeed(GitHubInstallationRepositoryCacheRepo, installationRepositories),
  );
};

const run = (
  spec: ReturnType<typeof specWithDotfilesAuthRef>,
  layers: Layer.Layer<GitHubInstallationRepo | GitHubInstallationRepositoryCacheRepo>,
) =>
  Effect.runPromise(
    validateClientSuppliedAuthRefs({ ownerUserId: "user_1", spec }).pipe(
      Effect.provide(layers),
      Effect.result,
    ),
  );

describe("client-supplied authRefs", () => {
  it("rejects a non-GitHub authRef — the value would become a host file path build secret", async () => {
    const result = await run(specWithDotfilesAuthRef("/root/.ssh/id_ed25519"), stubLayers({}));
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/must reference a GitHub installation repository/);
  });

  it("rejects a GitHub authRef for an installation the caller has no grant on", async () => {
    const result = await run(
      specWithDotfilesAuthRef("github-installation-repository:ghrepo_1"),
      stubLayers({ hasGrant: false }),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/does not have access/);
  });

  it("rejects a GitHub authRef for an unknown installation repository", async () => {
    const result = await run(
      specWithDotfilesAuthRef("github-installation-repository:ghrepo_unknown"),
      stubLayers({ record: undefined }),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/not found/);
  });

  it("rejects a GitHub authRef when the installation is suspended", async () => {
    const result = await run(
      specWithDotfilesAuthRef("github-installation-repository:ghrepo_1"),
      stubLayers({ installationStatus: "suspended" }),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/not active/);
  });

  it("accepts a GitHub authRef the caller has a grant on (the rerun path)", async () => {
    const result = await run(
      specWithDotfilesAuthRef("github-installation-repository:ghrepo_1"),
      stubLayers({}),
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it.each([
    "https://evil.example/o/dots.git",
    "https://github.com.evil.example/o/dots.git",
    "https://github.com@evil.example/o/dots.git",
    "https://token@github.com/o/dots.git",
    "http://github.com/o/dots.git",
    "https://github.com:8443/o/dots.git",
    "https://github.com/o/other.git",
    "https://github.com/someone-else/dots.git",
    "https://github.com/o/dots.git/../../x/y",
    "https://github.com/o/dots/extra",
    "https://github.com/o/%64ots.git",
    "https://github.com/o/dots.git?ref=x",
    "https://github.com/o/dots.git#x",
  ])("refuses to send the installation token to %s", async (url) => {
    const result = await run(
      specWithDotfilesAuthRef("github-installation-repository:ghrepo_1", url),
      stubLayers({}),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/not the repository this authRef was issued for/);
  });

  it("reads the repository it was issued for case-insensitively, with or without .git", async () => {
    for (const url of ["https://github.com/O/Dots", "https://GitHub.com/o/dots.git"]) {
      const result = await run(
        specWithDotfilesAuthRef("github-installation-repository:ghrepo_1", url),
        stubLayers({}),
      );
      expect(Result.isSuccess(result)).toBe(true);
    }
  });

  it("accepts a spec with no authRefs without touching the repositories", async () => {
    const spec = newWorkspaceSchema.parse({
      sources: { workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" } },
      harness: { id: "claude-code" },
    });
    // Empty stubs: any repository call would throw, proving none happens.
    const layers = Layer.mergeAll(
      Layer.succeed(GitHubInstallationRepo, {} as unknown as GitHubInstallationRepoService),
      Layer.succeed(
        GitHubInstallationRepositoryCacheRepo,
        {} as unknown as GitHubInstallationRepositoryCacheRepoService,
      ),
    );
    const result = await run(spec, layers);
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("validates the workspace source authRef too", async () => {
    const spec = newWorkspaceSchema.parse({
      sources: {
        workspace: {
          kind: "git",
          url: "https://github.com/o/app.git",
          authRef: "/etc/passwd",
        },
      },
      harness: { id: "claude-code" },
    });
    const result = await run(spec, stubLayers({}));
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/sources\.workspace/);
  });
});
