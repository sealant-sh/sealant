{
  # Minimal example: just enough to show repo checkout plus a small tool set.
  harness = "opencode";
  imageName = "sealant-workspace-minimal";
  repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  repoRef = "main";

  extraPackages = [
    "git"
    "ripgrep"
  ];

  env = {
    SEALANT_PROFILE = "minimal";
    SEALANT_SESSION_KIND = "docker-local";
  };
}
