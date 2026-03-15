# Temporary Nix Composition Example

This folder shows the basic flow you asked about:

1. Start with user choices as data in `nix/demo-spec.nix`
2. Feed that spec into a reusable Nix function in `nix/mk-workspace.nix`
3. Produce:
   - a workspace environment derivation
   - a Docker/OCI image derivation

## Files

- `flake.nix`: wires the example together as a standalone flake
- `nix/demo-spec.nix`: example normalized user input
- `nix/mk-workspace.nix`: composition logic that turns the spec into build outputs

## What this example does

- Selects a harness (`opencode`, `codex`, or `claude-code`)
- Maps `extraPackages` to Nix packages
- Writes the normalized request to `/etc/zweit/spec.json` in the image
- Builds a runtime environment with `bash`, `git`, and the selected tools
- Creates a Docker image whose entrypoint clones the target repo at startup

The important split is:

- build time: tools, harness selection, entrypoint, metadata file
- runtime: cloning the target repository

That keeps the image reusable while still letting each launch target a different repo.

## Build the environment derivation

```bash
nix build ./temp/nix-composition-example#workspace-env
```

## Build the Docker image

```bash
nix build ./temp/nix-composition-example#workspace-image
docker load < result
docker run --rm -it zweit-workspace-demo:opencode
```

## How to adapt this pattern

In the real backend, `nix/demo-spec.nix` would not be handwritten. Your API would:

1. validate and normalize user input
2. write a small generated spec file
3. call a shared function like `mk-workspace.nix`
4. build the selected output (`env`, `image`, or both)

That lets you keep all Nix logic in one place and only generate data per request.
