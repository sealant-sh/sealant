# Current Nix Executor Spec

This document describes the current Nix-facing input shape used by `@zweit/os-integration-nix`.

Longer term, the control plane should accept a higher-level `UserWorkspaceSpec`, normalize that into a `WorkspaceBlueprint`, and then derive a Nix-specific executor spec from it.

For now, the workspace builder accepts a normalized Nix attribute set with this shape:

```nix
{
  harness = "opencode";
  imageName = "zweit-workspace-demo";
  repoUrl = "https://github.com/example/project.git";
  repoRef = "main";

  extraPackages = [
    "nodejs"
    "pnpm"
    "ripgrep"
  ];

  env = {
    ZWEIT_PROFILE = "demo";
  };

  nixConfig = {
    repoUrl = "https://github.com/example/nixcfg.git";
    repoRef = "main";
    repoRev = "<pinned-commit-sha>";

    homeManagerModules = [
      "modules/clis/default.nix"
      "modules/ides/nvim-config/neovim.nix"
    ];
  };
}
```

## Notes

- `harness` currently supports `opencode`, `codex`, and `claude-code`
- `extraPackages` are symbolic names resolved by `nix/lib/package-map.nix`
- `nixConfig` is optional; when present it must include a pinned `repoRev`
- `env` is passed through to the container image config

The backend should generate this spec from validated user input rather than constructing Nix logic directly.
