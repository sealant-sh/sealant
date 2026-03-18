{
  pkgs,
  locale,
  homeManager,
}:
let
  lib = pkgs.lib;
in
{
  # SSH is runtime-optional, but the package is baked into the image so a
  # caller can enable it with environment flags.
  packages = [ pkgs.openssh ];

  script = ''
    if [ "''${SEALANT_ENABLE_SSH:-0}" = "1" ] || [ "''${SEALANT_ENABLE_SSH:-}" = "true" ]; then
      SSH_RUNTIME_DIR=/workspace/.ssh-runtime
      SSH_PORT="''${SEALANT_SSH_PORT:-2222}"
      SSH_AUTHORIZED_KEYS_FILE="''${SEALANT_SSH_AUTHORIZED_KEYS_FILE:-/run/keys/authorized_keys}"

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
        # Generate sshd_config from the same Nix-derived values used elsewhere
        # so locale and PATH stay consistent between console and SSH sessions.
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
        ${lib.optionalString (homeManager.sshSetEnv != "") ''
          printf '%s\n' '${homeManager.sshSetEnv}'
        ''}
        printf '%s\n' '${locale.sshSetEnv}'
        printf '%s\n' 'Subsystem sftp internal-sftp'
      } > "$SSH_RUNTIME_DIR/sshd_config"

      ${pkgs.openssh}/bin/sshd -f "$SSH_RUNTIME_DIR/sshd_config" -E "$SSH_RUNTIME_DIR/sshd.log"
      printf '%s\n' "SSH server listening on port $SSH_PORT"
    fi
  '';
}
