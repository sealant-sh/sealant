import { describe, expect, it } from "vitest";

import { normalizeUserWorkspaceSpec, parseUserWorkspaceSpec } from "./user-workspace-spec.js";

describe("parseUserWorkspaceSpec", () => {
  it("accepts ergonomic user input", () => {
    const spec = parseUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      ssh: true,
      packages: ["nodejs", "pnpm"],
      startup: "pnpm dev",
      os: "fedora",
    });

    expect(spec).toMatchObject({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      ssh: true,
      packages: ["nodejs", "pnpm"],
      startup: "pnpm dev",
      os: "fedora",
    });
  });

  it("rejects conflicting aliases", () => {
    expect(() =>
      parseUserWorkspaceSpec({
        source: "https://github.com/example/project.git",
        harness: "opencode",
        packages: ["nodejs"],
        tooling: {
          packages: ["pnpm"],
        },
      }),
    ).toThrowError(/Use only one of packages or tooling\.packages\./);
  });
});

describe("normalizeUserWorkspaceSpec", () => {
  it("turns shorthand user input into a normalized blueprint", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      ssh: {
        authorizedKeysRef: "secret://workspace/keys/main",
      },
      packages: ["nodejs", "pnpm", "nodejs"],
      setup: ["pnpm install"],
      startup: "pnpm dev",
      env: {
        NODE_ENV: "development",
      },
      os: "fedora",
    });

    expect(blueprint).toEqual({
      version: "1",
      sources: {
        workspace: {
          kind: "git",
          provider: "github",
          url: "https://github.com/example/project.git",
          ref: "main",
        },
        inputs: [],
      },
      harness: {
        id: "opencode",
      },
      access: {
        ssh: {
          enabled: true,
          listenPort: 2222,
          authorizedKeysRef: "secret://workspace/keys/main",
        },
      },
      tooling: {
        packages: [{ id: "nodejs" }, { id: "pnpm" }],
      },
      lifecycle: {
        setup: [
          {
            run: "pnpm install",
            shell: "bash",
          },
        ],
        startup: {
          steps: [],
          foreground: {
            kind: "command",
            run: "pnpm dev",
            shell: "bash",
          },
        },
      },
      runtime: {
        env: {
          NODE_ENV: "development",
        },
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        network: {
          outbound: true,
        },
      },
      target: {
        os: {
          family: "fedora",
          mode: "prefer",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });
  });

  it("normalizes nested source and lifecycle objects", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      sources: {
        workspace: {
          url: "https://gitlab.com/example/project.git",
          ref: "develop",
        },
        inputs: [
          {
            purpose: "config",
            url: "https://github.com/example/config.git",
          },
        ],
      },
      harness: {
        id: "claude-code",
        profile: "team-default",
      },
      lifecycle: {
        setup: [{ run: "./scripts/bootstrap.sh", shell: "sh" }],
        startup: {
          steps: ["./scripts/preflight.sh"],
          foreground: {
            kind: "harness",
          },
        },
      },
      target: {
        os: {
          family: "arch",
          mode: "require",
        },
        runtime: "k3s",
      },
    });

    expect(blueprint.sources.workspace.provider).toBe("gitlab");
    expect(blueprint.sources.inputs).toEqual([
      {
        id: "config-1",
        kind: "git",
        purpose: "config",
        provider: "github",
        url: "https://github.com/example/config.git",
        ref: "main",
      },
    ]);
    expect(blueprint.lifecycle).toEqual({
      setup: [{ run: "./scripts/bootstrap.sh", shell: "sh" }],
      startup: {
        steps: [{ run: "./scripts/preflight.sh", shell: "bash" }],
        foreground: { kind: "harness" },
      },
    });
    expect(blueprint.harness).toEqual({
      id: "claude-code",
      profile: "team-default",
    });
    expect(blueprint.target.os).toEqual({
      family: "arch",
      mode: "require",
    });
    expect(blueprint.target.runtime).toEqual({
      family: "k3s",
      mode: "prefer",
    });
  });
});
