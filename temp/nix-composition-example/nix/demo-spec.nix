{
  harness = "opencode";
  repoUrl = "https://github.com/ypanagidis/nixcfg.git";
  repoRef = "main";

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
