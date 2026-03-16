# Workspace Composition

`@zweit/workspace-composition` is the reusable Nix library that turns a normalized workspace spec into:

- a runnable environment derivation
- a Docker/OCI image
- a runtime entrypoint that handles repo checkout, locale setup, SSH, and optional Home Manager activation

The library is intentionally split into small Nix files so the control-plane layer can treat the request spec as data while reusing the same image builder logic everywhere.

## Layout

- `flake.nix`: library flake and example outputs
- `examples/`: example specs that exercise the library
- `docs/architecture.md`: high-level builder architecture
- `docs/request-spec.md`: the request/spec contract
- `nix/lib/`: normalization and fetch helpers
- `nix/harnesses/`: per-harness package and command selection
- `nix/modules/`: reusable runtime concerns such as locale, Home Manager, and SSH
- `nix/builders/`: final environment, entrypoint, image, and top-level workspace builders

## Build The Example Image

```bash
nix build "path:$PWD/packages/workspace-composition#example-opencode-home-manager-image"
docker load < result
docker run --rm -it zweit-workspace-demo:opencode
```

## Build The Minimal Example

```bash
nix build "path:$PWD/packages/workspace-composition#example-minimal-image"
```
