{
  homeManagerLib,
  pkgs,
  opencodePkg,
  spec,
}:
let
  lib = pkgs.lib;

  # Pull helper functions into one local namespace so the top-level builder can
  # read like orchestration instead of a bag of inline implementation details.
  helpers = import ../lib/default.nix;

  normalizeSpec = helpers.normalizeSpec { inherit lib; };
  packageMap = helpers.packageMap { inherit pkgs; };
  fetchConfigRepo = helpers.fetchConfigRepo;

  normalizedSpec = normalizeSpec spec;

  # Resolve symbolic package names from the spec to concrete nixpkgs packages.
  selectedPackages = map (
    name: packageMap.${name} or (throw "Unsupported package in spec.extraPackages: ${name}")
  ) normalizedSpec.extraPackages;

  # Optional external config repo used for imported Home Manager modules.
  configRepo = fetchConfigRepo { spec = normalizedSpec; };

  # Runtime concerns are split into modules so each one can stay focused.
  locale = import ../modules/locale.nix { inherit pkgs; };
  metadata = import ../modules/metadata.nix {
    inherit pkgs;
    spec = normalizedSpec;
  };
  nssFiles = import ../modules/nss-files.nix { inherit pkgs; };

  homeManager = import ../modules/home-manager.nix {
    inherit homeManagerLib pkgs configRepo;
    spec = normalizedSpec;
  };

  repoCheckout = import ../modules/repo-checkout.nix {
    spec = normalizedSpec;
  };

  # Harnesses encapsulate both package dependencies and the final exec command.
  harness = import ../harnesses/default.nix {
    inherit pkgs opencodePkg;
    harness = normalizedSpec.harness;
  };

  sshd = import ../modules/sshd.nix {
    inherit pkgs locale homeManager;
  };

  # The final builder output exposes both the low-level pieces and the full
  # image so callers can inspect or test intermediate artifacts if needed.
  entrypoint = import ./mk-entrypoint.nix {
    inherit
      pkgs
      harness
      locale
      homeManager
      repoCheckout
      sshd
      ;
    spec = normalizedSpec;
  };

  envVars = lib.mapAttrsToList (name: value: "${name}=${value}") normalizedSpec.env;

  env = import ./mk-env.nix {
    inherit
      pkgs
      locale
      nssFiles
      metadata
      entrypoint
      homeManager
      harness
      sshd
      selectedPackages
      ;
  };

  image = import ./mk-image.nix {
    inherit
      pkgs
      env
      entrypoint
      locale
      envVars
      ;
    spec = normalizedSpec;
  };
in
{
  inherit
    entrypoint
    env
    image
    normalizedSpec
    ;

  homeActivationPackage = homeManager.homeActivationPackage;
  specJson = metadata.specJson;
}
