{
  # Small registry of helper functions used by the top-level builder.
  normalizeSpec = import ./normalize-spec.nix;
  packageMap = import ./package-map.nix;
  fetchConfigRepo = import ./fetch-config-repo.nix;
}
