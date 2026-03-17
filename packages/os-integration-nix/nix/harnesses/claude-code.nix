{ pkgs }:
{
  # Placeholder until the real Claude Code runtime contract is wired in.
  banner = "Starting Claude Code workspace";
  command = "exec ${pkgs.bashInteractive}/bin/bash";
  packages = [ ];
}
