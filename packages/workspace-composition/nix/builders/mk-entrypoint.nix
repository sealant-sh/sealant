{
  pkgs,
  spec,
  harness,
  locale,
  homeManager,
  repoCheckout,
  sshd,
}:
# The entrypoint is where build-time decisions meet runtime behavior. It keeps
# the order explicit: environment setup, imported config activation, SSH, repo
# checkout, optional foreground override, then harness launch.
pkgs.writeShellScriptBin "workspace-entrypoint" ''
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
  ${locale.shellExports}

  # Apply imported user config before any interactive shell or editor starts.
  ${homeManager.activationScript}
  ${locale.zshInitScript}
  ${sshd.script}

  printf '%s\n' '${harness.banner}'
  ${repoCheckout.checkoutScript}

  # Foreground overrides make local debugging and smoke tests much easier than
  # always jumping straight into the selected harness.
  if [ -n "''${ZWEIT_FOREGROUND_COMMAND:-}" ]; then
    exec ${pkgs.bashInteractive}/bin/bash -lc "$ZWEIT_FOREGROUND_COMMAND"
  fi

  ${harness.command}
''
