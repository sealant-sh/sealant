{
  harness = "opencode";
  repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  repoRef = "main";

  # nixConfig = {
  #   repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  #   repoRef = "main";
  #   repoRev = "575ef2b10f63c76a525c7b7a63bc0ff1cfb95ca9";
  #
  #   homeManagerModules = [
  #     "modules/clis/default.nix"
  #     "modules/ides/nvim-config/neovim.nix"
  #   ];
  # };

  extraPackages = [
    "nodejs"
    "pnpm"
    "ripgrep"
    "jq"
  ];

  env = {
    ZWEIT_PROFILE = "demo";
    ZWEIT_SESSION_KIND = "docker-local";
  };
}
