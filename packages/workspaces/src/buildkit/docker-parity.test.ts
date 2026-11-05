import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { WorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { planWorkspaceImageBuild } from "./buildkit-builder.js";
import { createWorkspaceBuildSpec } from "./docker-parity.fixture.js";

/** Valid input matrix captured at 03a1f14, before extracting installation content. */
const dockerParityCases = () =>
  (["fedora", "arch", "ubuntu", "nix"] as const).flatMap((family) =>
    (["bash", "zsh", "fish"] as const).flatMap((shell) =>
      (["none", "public", "secret", "runtime"] as const).flatMap((dotfiles) =>
        (["codex", "claude-code", "opencode", "pi"] as const).map((harness) => {
          const spec = createWorkspaceBuildSpec({
            harness: { id: harness },
            target: {
              os: { family, mode: "require" },
              runtime: { family: "auto", mode: "prefer" },
            },
            customization: {
              defaultShell: shell,
              dotfilesManager: "auto",
              dotfilesTarget: "home",
              applyDotfiles: true,
              dotfilesBootstrap: true,
            },
          });
          const blueprint: WorkspaceBlueprint = {
            ...spec,
            sources: {
              ...spec.sources,
              inputs:
                dotfiles === "none"
                  ? []
                  : [
                      {
                        id: "dotfiles",
                        kind: "git" as const,
                        purpose: "dotfiles",
                        provider: "generic" as const,
                        url: "https://github.com/example/dotfiles.git",
                        ref: "main",
                        ...(dotfiles === "secret"
                          ? { authRef: "/keys/dotfiles" }
                          : dotfiles === "runtime"
                            ? { authRef: "github-installation-repository:repo_1" }
                            : {}),
                      },
                    ],
            },
          };
          const plan = planWorkspaceImageBuild({ blueprint, platform: "linux/amd64" });
          return {
            name: [family, shell, dotfiles, harness].join("/"),
            sha256: createHash("sha256").update(plan.containerfile).digest("hex"),
          };
        }),
      ),
    ),
  );

describe("Docker installation content extraction", () => {
  it("preserves every byte of the valid base matrix", () => {
    const baseline: unknown = JSON.parse(
      readFileSync(new URL("./docker-parity.json", import.meta.url), "utf8"),
    );
    expect(dockerParityCases()).toEqual(baseline);
  });
});
