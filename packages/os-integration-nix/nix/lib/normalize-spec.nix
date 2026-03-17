{ lib }:
spec:
let
  # Keep harness validation centralized so every caller gets the same contract.
  supportedHarnesses = [
    "opencode"
    "codex"
    "claude-code"
  ];

  normalizedNixConfig =
    # External config repos are optional, but once present we normalize the
    # fields the rest of the builder relies on.
    if spec ? nixConfig then
      (spec.nixConfig or { })
      // {
        repoRef = (spec.nixConfig.repoRef or "main");
        homeManagerModules = spec.nixConfig.homeManagerModules or [ ];
      }
    else
      null;

  normalizedSpec = spec // {
    # These defaults keep specs concise while still producing stable images.
    imageName = spec.imageName or "zweit-workspace-demo";
    repoRef = spec.repoRef or "main";
    extraPackages = spec.extraPackages or [ ];
    env = spec.env or { };
    nixConfig = normalizedNixConfig;
  };
in
# Fail fast on obviously invalid specs before any fetching or image assembly
# starts.
assert lib.elem normalizedSpec.harness supportedHarnesses;
assert normalizedSpec.repoUrl != "";
assert normalizedNixConfig == null || normalizedNixConfig ? repoUrl;
assert normalizedNixConfig == null || normalizedNixConfig ? repoRev;
normalizedSpec
