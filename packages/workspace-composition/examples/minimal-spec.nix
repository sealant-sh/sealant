{
  # Minimal example: just enough to show repo checkout plus a small tool set.
  harness = "opencode";
  imageName = "zweit-workspace-minimal";
  repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  repoRef = "main";

  extraPackages = [
    "git"
    "ripgrep"
  ];

  env = {
    ZWEIT_PROFILE = "minimal";
    ZWEIT_SESSION_KIND = "docker-local";
  };
}
