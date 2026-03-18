{
  # Root flake only provides the repository development shell. The heavier
  # image-building logic lives in packages/workspace-composition.
  description = "Sealant development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        # Keep the root shell intentionally small: enough to work on the repo,
        # but not coupled to the runtime image contents.
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bat
            nodejs_24
            nodePackages.pnpm
          ];
        };
      }
    );
}
