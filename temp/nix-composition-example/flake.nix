{
  description = "Temporary example of turning user input into a Nix environment and OCI image";

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

        opencodePkg = opencode.packages.${system}.opencode;

        demoSpec = import ./nix/demo-spec.nix;
        workspace = import ./nix/mk-workspace.nix {
          homeManagerLib = home-manager.lib;
          inherit pkgs;
          inherit opencodePkg;
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
          workspace-home-activation = workspace.homeActivationPackage;
          workspace-spec-json = workspace.specJson;
        };

        legacyPackages = {
          inherit demoSpec;
        };
      }
    );
}
