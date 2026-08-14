import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { opencode } from "../harness.js";
import { buildCreateWorkspaceRequest } from "./blueprint.js";
import type { SealantInternalConfig } from "./config.js";

const config: SealantInternalConfig = {
  baseUrl: "http://localhost:4000",
  apiKey: undefined,
  fetch: undefined,
  hostLocal: { ownerUserId: "usr_local", registryId: "default" },
};

interface SpecShape {
  readonly sources: {
    readonly workspace: {
      readonly kind?: string;
      readonly url?: string;
      readonly ref?: string;
      readonly hostPath?: string;
    };
    readonly mounts?: ReadonlyArray<{
      readonly hostPath: string;
      readonly mountPath: string;
      readonly readOnly?: boolean;
    }>;
  };
  readonly harness: { readonly id: string };
  readonly customization: { readonly enableSealantd: boolean };
  readonly tooling?: {
    readonly services?: { readonly docker?: { readonly enabled: boolean } };
  };
  readonly target: { readonly runtime: { readonly family: string } };
  readonly credentials?: {
    readonly profileId?: string;
    readonly claude?: string;
    readonly codex?: string;
    readonly github?: string;
  };
}

describe("buildCreateWorkspaceRequest", () => {
  it("lowers {repository, harness} onto the create contract", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "github.com/acme/billing-service", harness: opencode() },
      config,
    );
    expect(payload.ownerUserId).toBe("usr_local");
    expect(payload.registryId).toBe("default");
    expect(payload.repository).toBe("billing-service"); // sanitized source tail
    expect(payload.tag).toMatch(/^sdk-/);

    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.workspace.url).toBe("https://github.com/acme/billing-service.git");
    // No ref requested → none sent; the clone resolves the repository's default branch.
    expect(spec.sources.workspace.ref).toBeUndefined();
    expect(spec.harness.id).toBe("opencode");
    expect(spec.customization.enableSealantd).toBe(true);
    expect(spec.target.runtime.family).toBe("docker");
  });

  it("preserves a requested workspace-scoped Docker service", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/billing-service",
        harness: opencode(),
        services: { docker: true },
      },
      config,
    );

    const spec = payload.spec as unknown as SpecShape;
    expect(spec.tooling?.services?.docker).toEqual({ enabled: true });
  });

  it("passes through full git urls and honors an explicit ref", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "https://gitlab.com/x/y.git", ref: "master", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.workspace.url).toBe("https://gitlab.com/x/y.git");
    expect(spec.sources.workspace.ref).toBe("master");
  });

  it("lowers a mount source onto the blueprint and derives the slug from the path tail", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { source: { kind: "mount", path: "/srv/store/worktrees/session-1" }, harness: opencode() },
      config,
    );
    expect(payload.repository).toBe("session-1");
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.workspace).toEqual({
      kind: "mount",
      hostPath: "/srv/store/worktrees/session-1",
    });
  });

  it("automatically carries a linked worktree's shared Git directory as a writable bind", () => {
    const root = mkdtempSync(join(tmpdir(), "sealant-blueprint-worktree-"));
    try {
      const repository = join(root, "repo.git");
      const worktree = join(root, "worktrees", "session-1");
      const gitDirectory = join(repository, "worktrees", "session-1");
      mkdirSync(gitDirectory, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(gitDirectory, "commondir"), "../..\n");
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);

      const { payload } = buildCreateWorkspaceRequest(
        { source: { kind: "mount", path: worktree }, harness: opencode() },
        config,
      );
      const spec = payload.spec as unknown as SpecShape;

      expect(spec.sources.mounts).toEqual([
        { hostPath: repository, mountPath: repository, readOnly: false },
      ]);

      const withExistingBind = buildCreateWorkspaceRequest(
        {
          source: { kind: "mount", path: worktree },
          harness: opencode(),
          mounts: [{ hostPath: repository, mountPath: repository, readOnly: false }],
        },
        config,
      );
      const existingSpec = withExistingBind.payload.spec as unknown as SpecShape;
      expect(existingSpec.sources.mounts).toHaveLength(1);

      expect(() =>
        buildCreateWorkspaceRequest(
          {
            source: { kind: "mount", path: worktree },
            harness: opencode(),
            mounts: [{ hostPath: repository, mountPath: repository }],
          },
          config,
        ),
      ).toThrow(/required for writable linked-worktree Git metadata/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("folds extra mounts into `spec.sources.mounts`, sending readOnly only when chosen", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        source: { kind: "mount", path: "/srv/store/worktrees/session-1" },
        harness: opencode(),
        mounts: [
          { hostPath: "/srv/store/_references/effect", mountPath: "/workspace/ref/effect" },
          { hostPath: "/srv/store/scratch", mountPath: "/workspace/home/scratch", readOnly: false },
        ],
      },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.mounts).toEqual([
      // No readOnly key: the blueprint default (read-only) applies server-side.
      { hostPath: "/srv/store/_references/effect", mountPath: "/workspace/ref/effect" },
      { hostPath: "/srv/store/scratch", mountPath: "/workspace/home/scratch", readOnly: false },
    ]);
  });

  it("omits `spec.sources.mounts` when no extra mounts were requested", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { source: { kind: "mount", path: "/srv/store/worktrees/session-1" }, harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.mounts).toBeUndefined();
  });

  it("rejects both or neither of repository and source, and ref on a mount", () => {
    expect(() => buildCreateWorkspaceRequest({ harness: opencode() }, config)).toThrow(
      /exactly one of/,
    );
    expect(() =>
      buildCreateWorkspaceRequest(
        {
          repository: "github.com/acme/billing-service",
          source: { kind: "mount", path: "/srv/store/wt" },
          harness: opencode(),
        },
        config,
      ),
    ).toThrow(/exactly one of/);
    expect(() =>
      buildCreateWorkspaceRequest(
        { source: { kind: "mount", path: "/srv/store/wt" }, ref: "main", harness: opencode() },
        config,
      ),
    ).toThrow(/applies only to `repository` sources/);
  });

  it("omits `spec.credentials` when no credentials were requested", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "github.com/acme/billing-service", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.credentials).toBeUndefined();
  });

  it("folds mapped credentials into `spec.credentials`", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/billing-service",
        harness: opencode(),
        credentials: { profile: "prof_123", claude: true, github: "bot-account" },
      },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.credentials).toEqual({
      profileId: "prof_123",
      claude: "default",
      github: "bot-account",
    });
  });
});

interface DotfilesSpecShape {
  readonly sources: {
    readonly inputs?: ReadonlyArray<{
      readonly id: string;
      readonly purpose: string;
      readonly url: string;
      readonly ref?: string;
    }>;
  };
  readonly customization: {
    readonly defaultShell?: string;
    readonly dotfilesManager?: string;
    readonly dotfilesBootstrap?: boolean;
    readonly dotfilesBootstrapCommand?: string;
  };
  readonly runtime?: {
    readonly dotfilesArchives?: ReadonlyArray<{
      readonly data: string;
      readonly manager?: string;
      readonly target?: string;
      readonly bootstrap?: boolean;
    }>;
  };
}

describe("dotfiles and shell lowering", () => {
  it("lowers a dotfiles repository onto sources.inputs + customization", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/app",
        harness: opencode(),
        shell: "zsh",
        dotfiles: {
          repository: {
            url: "github.com/acme/dotfiles",
            manager: "chezmoi",
            bootstrap: false,
          },
        },
      },
      config,
    );
    const spec = payload.spec as unknown as DotfilesSpecShape;
    expect(spec.sources.inputs).toEqual([
      {
        id: "dotfiles",
        kind: "git",
        purpose: "dotfiles",
        provider: "generic",
        url: "https://github.com/acme/dotfiles.git",
      },
    ]);
    expect(spec.customization.defaultShell).toBe("zsh");
    expect(spec.customization.dotfilesManager).toBe("chezmoi");
    expect(spec.customization.dotfilesBootstrap).toBe(false);
    // No ref requested → none sent; the clone resolves the remote's default branch.
    expect(spec.sources.inputs?.[0]?.ref).toBeUndefined();
  });

  it("lowers dotfiles archives onto runtime.dotfilesArchives", () => {
    const data = Buffer.from("tar").toString("base64");
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/app",
        harness: opencode(),
        dotfiles: {
          archives: [{ data, manager: "copy", bootstrap: false }, { data }],
        },
      },
      config,
    );
    const spec = payload.spec as unknown as DotfilesSpecShape;
    expect(spec.runtime?.dotfilesArchives).toEqual([
      { data, manager: "copy", bootstrap: false },
      { data },
    ]);
    expect(spec.sources.inputs).toBeUndefined();
  });

  it("rejects dotfiles with a custom base image, client-side and readable", () => {
    expect(() =>
      buildCreateWorkspaceRequest(
        {
          repository: "github.com/acme/app",
          harness: opencode(),
          baseImage: "node:22-bookworm",
          dotfiles: { repository: { url: "github.com/acme/dotfiles" } },
        },
        config,
      ),
    ).toThrow(/not supported with `baseImage`/);
  });

  it("rejects a non-bash shell with a custom base image", () => {
    expect(() =>
      buildCreateWorkspaceRequest(
        {
          repository: "github.com/acme/app",
          harness: opencode(),
          baseImage: "node:22-bookworm",
          shell: "zsh",
        },
        config,
      ),
    ).toThrow(/`shell` is not supported/);
  });

  it("rejects an empty dotfiles option", () => {
    expect(() =>
      buildCreateWorkspaceRequest(
        {
          repository: "github.com/acme/app",
          harness: opencode(),
          dotfiles: {},
        },
        config,
      ),
    ).toThrow(/requires a `repository`/);
  });
});
