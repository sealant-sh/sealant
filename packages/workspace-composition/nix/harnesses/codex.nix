{ pkgs }:
{
  # Placeholder until the real Codex runtime contract is wired in.
  banner = "Starting Codex workspace";
  command = "exec ${pkgs.bashInteractive}/bin/bash";
  packages = [ ];
}
