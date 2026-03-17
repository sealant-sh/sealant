{
  pkgs,
  opencodePkg,
  harness,
}:
let
  # Harnesses stay in separate files so the runtime command and package wiring
  # for each tool can evolve independently.
  harnesses = {
    opencode = import ./opencode.nix { inherit opencodePkg; };
    codex = import ./codex.nix { inherit pkgs; };
    "claude-code" = import ./claude-code.nix { inherit pkgs; };
  };
in
harnesses.${harness} or (throw "Unsupported harness: ${harness}")
