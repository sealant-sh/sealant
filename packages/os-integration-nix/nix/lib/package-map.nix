{ pkgs }:
{
  # Specs refer to symbolic package names so the backend does not need to know
  # nixpkgs attribute paths.
  curl = pkgs.curl;
  git = pkgs.git;
  jq = pkgs.jq;
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.nodePackages.pnpm;
  ripgrep = pkgs.ripgrep;
}
