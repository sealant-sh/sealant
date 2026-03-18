{
  # Full demo example: OpenCode, JS tooling, and imported Home Manager modules
  # from the pinned nixcfg repository.
  harness = "opencode";
  imageName = "sealant-workspace-demo";
  repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  repoRef = "main";

  nixConfig = {
    # Pin the config repo so example images stay reproducible across rebuilds.
    repoUrl = "https://github.com/ypanagidis/nixcfg.git";
    repoRef = "main";
    repoRev = "575ef2b10f63c76a525c7b7a63bc0ff1cfb95ca9";

    homeManagerModules = [
      "modules/clis/default.nix"
      "modules/ides/nvim-config/neovim.nix"
    ];
  };

  extraPackages = [
    "nodejs"
    "pnpm"
    "ripgrep"
    "jq"
  ];

  env = {
    SEALANT_PROFILE = "demo";
    SEALANT_SESSION_KIND = "docker-local";
  };
}
