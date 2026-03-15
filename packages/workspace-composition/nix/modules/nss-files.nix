{ pkgs }:
# Minimal NSS/passwd/group data for scratch-like container images. This keeps
# root shells, sshd, and tools that inspect users/groups working correctly.
pkgs.buildEnv {
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
}
