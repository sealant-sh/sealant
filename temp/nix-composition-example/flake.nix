{
  description = "Temporary example of turning user input into a Nix environment and OCI image";

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
        pkgs = import nixpkgs {
          inherit system;
        };

        demoSpec = import ./nix/demo-spec.nix;
        workspace = import ./nix/mk-workspace.nix {
          inherit pkgs;
          spec = demoSpec;
        };
      in
      {
        formatter = pkgs.nixfmt-rfc-style;

        packages = {
          default = workspace.image;
          workspace-env = workspace.env;
          workspace-image = workspace.image;
          workspace-entrypoint = workspace.entrypoint;
          workspace-spec-json = workspace.specJson;
        };

        legacyPackages = {
          inherit demoSpec;
        };
      }
    );
}
