{
  # This flake is the reusable entrypoint for workspace composition. It exposes
  # the library builder plus a couple of concrete example outputs.
  description = "Reusable workspace composition for Zweit images";

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
        # Imported config repos currently expect oxfmt and tsgo in PATH, so we
        # provide small compatibility wrappers until nixpkgs covers that setup.
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (final: _prev: {
              # Keep these tools available to imported configs until they are
              # packaged directly in nixpkgs for the target channel we use.
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
          # Keep the public API tiny: callers hand us a normalized-ish spec and
          # the builder takes care of the rest.
          import ./nix/builders/mk-workspace.nix {
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
        # We expose example outputs directly from the flake so local iteration
        # does not need a separate CLI wrapper before the backend exists.
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
