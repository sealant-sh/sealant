# Convenience import for callers that want the package as a plain Nix module
# rather than going through the flake outputs.
args: import ./nix/builders/mk-workspace.nix args
