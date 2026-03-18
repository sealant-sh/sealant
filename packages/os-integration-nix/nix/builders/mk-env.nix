{
  pkgs,
  locale,
  nssFiles,
  metadata,
  entrypoint,
  homeManager,
  harness,
  sshd,
  selectedPackages,
}:
# Assemble the immutable runtime closure. This is the set of store paths that
# will end up reachable from the final image layers.
pkgs.buildEnv {
  name = "sealant-workspace-env";

  paths = [
    # Baseline tools every workspace gets even without extraPackages.
    pkgs.cacert
    pkgs.bat
    pkgs.bashInteractive
    pkgs.coreutils
    pkgs.curl
    pkgs.git
    pkgs.zsh
    nssFiles
    entrypoint
    metadata.specJson
  ]
  ++ locale.packages
  ++ homeManager.extraPackages
  ++ harness.packages
  ++ sshd.packages
  ++ selectedPackages;

  pathsToLink = [
    "/bin"
    "/etc"
  ];
}
