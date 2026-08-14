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

const specWithDotfilesAuthRef = (authRef: string) =>
  newWorkspaceSchema.parse({
    sources: {
      workspace: { kind: "mount", hostPath: "/srv/store/worktrees/session-1" },
      inputs: [
        {
          id: "dotfiles-test",
          purpose: "dotfiles",
          url: "https://github.com/o/dots.git",
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
