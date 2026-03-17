# Convenience import for callers that want the Nix OS integration as a plain
# Nix module rather than going through a flake output.
args: import ./nix/builders/mk-workspace.nix args
