{
  description = "Nix OS integration for Sealant workspace composition";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    opencode = {
      url = "github:anomalyco/opencode";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      home-manager,
      opencode,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (final: _prev: {
              oxfmt = final.writeShellScriptBin "oxfmt" ''
                exec ${final.nodejs_24}/bin/npx -y oxfmt "$@"
              '';

              tsgo = final.writeShellScriptBin "tsgo" ''
                exec ${final.nodejs_24}/bin/npx -y @typescript/native-preview "$@"
              '';
            })
          ];
        };

        mkWorkspace =
          spec:
          import ./default.nix {
            homeManagerLib = home-manager.lib;
            inherit pkgs;
            opencodePkg = opencode.packages.${system}.opencode;
            inherit spec;
          };

        minimalExample = import ./examples/minimal-spec.nix;
        opencodeHomeManagerExample = import ./examples/opencode-with-home-manager.nix;

        minimalWorkspace = mkWorkspace minimalExample;
        opencodeHomeManagerWorkspace = mkWorkspace opencodeHomeManagerExample;
      in
      {
        formatter = pkgs.nixfmt-rfc-style;

        legacyPackages = {
          inherit mkWorkspace;
        };

        packages = {
          default = opencodeHomeManagerWorkspace.image;

          example-minimal-env = minimalWorkspace.env;
          example-minimal-image = minimalWorkspace.image;

          example-opencode-home-manager-env = opencodeHomeManagerWorkspace.env;
          example-opencode-home-manager-image = opencodeHomeManagerWorkspace.image;
        };
      }
    );
}
