{
  homeManagerLib,
  pkgs,
  opencodePkg,
  spec,
}:
let
  lib = pkgs.lib;
  nixConfig = spec.nixConfig or null;
  localeArchive = "${pkgs.glibcLocales}/lib/locale/locale-archive";

  packageMap = {
    curl = pkgs.curl;
    git = pkgs.git;
    jq = pkgs.jq;
    nodejs = pkgs.nodejs_24;
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

  configRepo =
    if nixConfig == null then
      null
    else
      builtins.fetchGit {
        url = nixConfig.repoUrl;
        ref = nixConfig.repoRef or "main";
        rev = nixConfig.repoRev;
      };

  homeManagerModules =
    if nixConfig == null then
      [ ]
    else
      map (modulePath: configRepo + "/${modulePath}") nixConfig.homeManagerModules;

  homeConfiguration =
    if nixConfig == null then
      null
    else
      homeManagerLib.homeManagerConfiguration {
        inherit pkgs;

        modules = [
          {
            home.username = "root";
            home.homeDirectory = "/root";
            home.stateVersion = "25.11";
            programs.home-manager.enable = false;
          }
        ]
        ++ homeManagerModules;
      };

  homeActivationPackage =
    if homeConfiguration == null then null else homeConfiguration.activationPackage;

  nssFiles = pkgs.buildEnv {
    name = "zweit-nss-files";
    paths = [
      (pkgs.writeTextDir "etc/passwd" ''
        root:x:0:0:root:/root:/bin/zsh
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
    mkdir -p /workspace/.ssh-runtime
    mkdir -p /root
    mkdir -p /tmp
    mkdir -p /var/empty
    mkdir -p /run/sshd
    cd /workspace

    export HOME=/root
    export USER=root
    export LOGNAME=root
    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8
    export LOCALE_ARCHIVE=${localeArchive}

    ${lib.optionalString (homeActivationPackage != null) ''
            cp -a ${homeActivationPackage}/home-files/. "$HOME/"
            export PATH=${homeActivationPackage}/home-path/bin:$PATH

            if [ -f ${homeActivationPackage}/hm-session-vars.sh ]; then
              . ${homeActivationPackage}/hm-session-vars.sh
            fi

            if [ -f "$HOME/.local/share/nvim/site/pack/hm/start/nvim-treesitter/lua/nvim-treesitter/config.lua" ] && [ ! -f "$HOME/.config/nvim/lua/nvim-treesitter/configs.lua" ]; then
              mkdir -p "$HOME/.config/nvim/lua/nvim-treesitter"
              cat > "$HOME/.config/nvim/lua/nvim-treesitter/configs.lua" <<'EOF'
      return require("nvim-treesitter.config")
      EOF
            fi
    ''}

    if [ -f "$HOME/.zshenv" ]; then
      printf '%s\n' \
        'export LANG=en_US.UTF-8' \
        'export LC_ALL=en_US.UTF-8' \
        'export LOCALE_ARCHIVE=${localeArchive}' \
        > "$HOME/.zshenv.zweit"
      cat "$HOME/.zshenv" >> "$HOME/.zshenv.zweit"
      mv "$HOME/.zshenv.zweit" "$HOME/.zshenv"
    else
      printf '%s\n' \
        'export LANG=en_US.UTF-8' \
        'export LC_ALL=en_US.UTF-8' \
        'export LOCALE_ARCHIVE=${localeArchive}' \
        > "$HOME/.zshenv"
    fi

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

      {
        printf '%s\n' "Port $SSH_PORT"
        printf '%s\n' 'ListenAddress 0.0.0.0'
        printf '%s\n' "HostKey $SSH_RUNTIME_DIR/ssh_host_ed25519_key"
        printf '%s\n' "AuthorizedKeysFile $SSH_RUNTIME_DIR/authorized_keys"
        printf '%s\n' 'PasswordAuthentication no'
        printf '%s\n' 'KbdInteractiveAuthentication no'
        printf '%s\n' 'ChallengeResponseAuthentication no'
        printf '%s\n' 'PubkeyAuthentication yes'
        printf '%s\n' 'PermitRootLogin yes'
        printf '%s\n' 'PermitEmptyPasswords no'
        printf '%s\n' 'UsePAM no'
        printf '%s\n' "PidFile $SSH_RUNTIME_DIR/sshd.pid"
        printf '%s\n' 'PrintMotd no'
        printf '%s\n' 'StrictModes yes'
        ${lib.optionalString (homeActivationPackage != null) ''
          printf '%s\n' 'SetEnv PATH=${homeActivationPackage}/home-path/bin:/bin'
        ''}
        printf '%s\n' 'SetEnv LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LOCALE_ARCHIVE=${localeArchive}'
        printf '%s\n' 'Subsystem sftp internal-sftp'
      } > "$SSH_RUNTIME_DIR/sshd_config"

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
      pkgs.curl
      pkgs.git
      pkgs.glibcLocales
      pkgs.zsh
      pkgs.openssh
      nssFiles
      opencodePkg
      entrypoint
      specJson
    ]
    ++ lib.optionals (homeActivationPackage != null) [ homeActivationPackage ]
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
        "LANG=en_US.UTF-8"
        "LC_ALL=en_US.UTF-8"
        "LOCALE_ARCHIVE=${localeArchive}"
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
    homeActivationPackage
    image
    specJson
    ;
}
