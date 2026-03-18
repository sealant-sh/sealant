import { describe, expect, it } from "vitest";

import { parseWorkspaceBlueprint } from "./blueprint.js";

describe("parseWorkspaceBlueprint", () => {
  it("applies defaults to optional sections", () => {
    const blueprint = parseWorkspaceBlueprint({
      sources: {
        workspace: {
          url: "https://github.com/example/project.git",
        },
      },
      harness: {
        id: "opencode",
      },
    });

    expect(blueprint).toMatchObject({
      version: "1",
      sources: {
        workspace: {
          kind: "git",
          provider: "generic",
          url: "https://github.com/example/project.git",
          ref: "main",
        },
        inputs: [],
      },
      access: {
        ssh: {
          enabled: false,
          listenPort: 2222,
        },
      },
      tooling: {
        packages: [],
      },
      lifecycle: {
        setup: [],
        startup: {
          steps: [],
          foreground: {
            kind: "harness",
          },
        },
      },
      runtime: {
        env: {},
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        network: {
          outbound: true,
        },
      },
      target: {
        os: {
          family: "auto",
          mode: "prefer",
        },
      },
    });
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseWorkspaceBlueprint({
        sources: {
          workspace: {
            url: "https://github.com/example/project.git",
          },
        },
        harness: {
          id: "opencode",
        },
        unsupported: true,
      }),
    ).toThrowError();
  });
});
