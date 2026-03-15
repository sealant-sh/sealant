{
  pkgs,
  spec,
}:
let
  lib = pkgs.lib;

  packageMap = {
    curl = pkgs.curl;
    git = pkgs.git;
    jq = pkgs.jq;
    nodejs = pkgs.nodejs_latest;
    pnpm = pkgs.nodePackages.pnpm;
    ripgrep = pkgs.ripgrep;
  };

  selectedPackages = map (
    name: packageMap.${name} or (throw "Unsupported package in spec.extraPackages: ${name}")
  ) (spec.extraPackages or [ ]);

  harnessBanner =
    {
      opencode = "Starting OpenCode workspace";
      codex = "Starting Codex workspace";
      claude-code = "Starting Claude Code workspace";
    }
    .${spec.harness} or (throw "Unsupported harness: ${spec.harness}");

  repoRef = spec.repoRef or "main";

  envVars = lib.mapAttrsToList (name: value: "${name}=${value}") (spec.env or { });

  specJson = pkgs.writeTextDir "etc/zweit/spec.json" (builtins.toJSON spec);

  entrypoint = pkgs.writeShellScriptBin "workspace-entrypoint" ''
    set -euo pipefail

    mkdir -p /workspace
    cd /workspace

    printf '%s\n' '${harnessBanner}'
    printf '%s\n' 'Repo: ${spec.repoUrl}'
    printf '%s\n' 'Ref: ${repoRef}'
    printf '%s\n' 'Spec file: /etc/zweit/spec.json'

    if [ ! -d repo/.git ]; then
      git clone --branch '${repoRef}' '${spec.repoUrl}' repo
    fi

    cd repo
    exec ${pkgs.bashInteractive}/bin/bash
  '';

  env = pkgs.buildEnv {
    name = "zweit-workspace-env";

    paths = [
      pkgs.cacert
      pkgs.bat
      pkgs.bashInteractive
      pkgs.coreutils
      pkgs.git
      entrypoint
      specJson
    ]
    ++ selectedPackages;

    pathsToLink = [
      "/bin"
      "/etc"
    ];
  };

  image = pkgs.dockerTools.buildLayeredImage {
    name = "zweit-workspace-demo";
    tag = spec.harness;

    contents = [ env ];

    config = {
      Cmd = [ "${entrypoint}/bin/workspace-entrypoint" ];
      WorkingDir = "/workspace";
      Env = [
        "PATH=/bin"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ]
      ++ envVars;
    };
  };
in
{
  inherit
    entrypoint
    env
    image
    specJson
    ;
}
