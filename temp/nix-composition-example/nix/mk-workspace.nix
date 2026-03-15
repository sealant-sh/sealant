{
  pkgs,
  opencodePkg,
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

  harnessCommand =
    {
      opencode = "exec ${opencodePkg}/bin/opencode";
      codex = "exec ${pkgs.bashInteractive}/bin/bash";
      claude-code = "exec ${pkgs.bashInteractive}/bin/bash";
    }
    .${spec.harness} or (throw "Unsupported harness: ${spec.harness}");

  repoRef = spec.repoRef or "main";

  envVars = lib.mapAttrsToList (name: value: "${name}=${value}") (spec.env or { });

  nssFiles = pkgs.buildEnv {
    name = "zweit-nss-files";
    paths = [
      (pkgs.writeTextDir "etc/passwd" ''
        root:x:0:0:root:/root:/bin/bash
        sshd:x:74:74:sshd privilege separation user:/var/empty:/bin/nologin
      '')
      (pkgs.writeTextDir "etc/group" ''
        root:x:0:
        sshd:x:74:
      '')
      (pkgs.writeTextDir "etc/nsswitch.conf" ''
        passwd: files
        group: files
        shadow: files
        hosts: files dns
      '')
      (pkgs.writeTextDir "var/empty/.keep" "")
    ];

    pathsToLink = [
      "/etc"
      "/var"
    ];
  };

  specJson = pkgs.writeTextDir "etc/zweit/spec.json" (builtins.toJSON spec);

  entrypoint = pkgs.writeShellScriptBin "workspace-entrypoint" ''
        set -euo pipefail

    mkdir -p /workspace
    mkdir -p /workspace/.home
    mkdir -p /workspace/.ssh-runtime
    mkdir -p /root
    mkdir -p /var/empty
    mkdir -p /run/sshd
        cd /workspace

        export HOME=/workspace/.home

        if [ "''${ZWEIT_ENABLE_SSH:-0}" = "1" ] || [ "''${ZWEIT_ENABLE_SSH:-}" = "true" ]; then
          SSH_RUNTIME_DIR=/workspace/.ssh-runtime
          SSH_PORT="''${ZWEIT_SSH_PORT:-2222}"
          SSH_AUTHORIZED_KEYS_FILE="''${ZWEIT_SSH_AUTHORIZED_KEYS_FILE:-/run/keys/authorized_keys}"

          if [ ! -f "$SSH_AUTHORIZED_KEYS_FILE" ]; then
            printf '%s\n' "SSH enabled but no authorized keys file found at $SSH_AUTHORIZED_KEYS_FILE" >&2
            exit 1
          fi

          install -m 700 -d "$SSH_RUNTIME_DIR"
          install -m 600 "$SSH_AUTHORIZED_KEYS_FILE" "$SSH_RUNTIME_DIR/authorized_keys"

          if [ ! -f "$SSH_RUNTIME_DIR/ssh_host_ed25519_key" ]; then
            ${pkgs.openssh}/bin/ssh-keygen -q -t ed25519 -N "" -f "$SSH_RUNTIME_DIR/ssh_host_ed25519_key"
          fi

          cat > "$SSH_RUNTIME_DIR/sshd_config" <<EOF
    Port $SSH_PORT
    ListenAddress 0.0.0.0
    HostKey $SSH_RUNTIME_DIR/ssh_host_ed25519_key
    AuthorizedKeysFile $SSH_RUNTIME_DIR/authorized_keys
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ChallengeResponseAuthentication no
    PubkeyAuthentication yes
    PermitRootLogin yes
    PermitEmptyPasswords no
    UsePAM no
    PidFile $SSH_RUNTIME_DIR/sshd.pid
    PrintMotd no
    StrictModes yes
    Subsystem sftp internal-sftp
    EOF

          ${pkgs.openssh}/bin/sshd -f "$SSH_RUNTIME_DIR/sshd_config" -E "$SSH_RUNTIME_DIR/sshd.log"
          printf '%s\n' "SSH server listening on port $SSH_PORT"
        fi

        printf '%s\n' '${harnessBanner}'
        printf '%s\n' 'Repo: ${spec.repoUrl}'
        printf '%s\n' 'Ref: ${repoRef}'
        printf '%s\n' 'Spec file: /etc/zweit/spec.json'

        if [ ! -d repo/.git ]; then
          git clone --branch '${repoRef}' '${spec.repoUrl}' repo
        fi

        cd repo

        if [ -n "''${ZWEIT_FOREGROUND_COMMAND:-}" ]; then
          exec ${pkgs.bashInteractive}/bin/bash -lc "$ZWEIT_FOREGROUND_COMMAND"
        fi

        ${harnessCommand}
  '';

  env = pkgs.buildEnv {
    name = "zweit-workspace-env";

    paths = [
      pkgs.cacert
      pkgs.bat
      pkgs.bashInteractive
      pkgs.coreutils
      pkgs.git
      pkgs.openssh
      nssFiles
      opencodePkg
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
      ExposedPorts = {
        "2222/tcp" = { };
      };
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
