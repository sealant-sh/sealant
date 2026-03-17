{ pkgs }:
let
  # We keep the locale archive path in one place because both the image config
  # and interactive shell startup need the same value.
  localeArchive = "${pkgs.glibcLocales}/lib/locale/locale-archive";
in
{
  inherit localeArchive;

  env = [
    "LANG=en_US.UTF-8"
    "LC_ALL=en_US.UTF-8"
    "LOCALE_ARCHIVE=${localeArchive}"
  ];

  packages = [ pkgs.glibcLocales ];

  # Export locale vars in the entrypoint before any shell config is sourced.
  shellExports = ''
    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8
    export LOCALE_ARCHIVE=${localeArchive}
  '';

  # Zsh reads .zshenv before prompt setup, so we prepend locale exports there to
  # keep powerlevel10k and other unicode-heavy configs running in UTF-8 mode.
  zshInitScript = ''
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
  '';

  # SSH sessions need the same locale propagated through sshd or prompt setup
  # will break even if the container process itself is UTF-8 aware.
  sshSetEnv = "SetEnv LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LOCALE_ARCHIVE=${localeArchive}";
}
