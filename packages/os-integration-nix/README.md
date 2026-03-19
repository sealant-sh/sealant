# Nix OS Integration

`@sealant/os-integration-nix` is the concrete Nix-backed OS integration for Sealant workspace composition.

It turns a workspace definition into:

- a runnable environment derivation
- a Docker/OCI image
- a runtime entrypoint that handles repo checkout, locale setup, SSH, and optional Home Manager
  activation

## Layout

- `flake.nix`: library flake and example outputs for the Nix integration
- `default.nix`: plain Nix entrypoint for the integration
- `src/`: TypeScript wrapper that maps shared workspace contracts into the current Nix executor spec
- `examples/`: example Nix executor specs
- `docs/architecture.md`: high-level Nix build and runtime architecture
- `docs/request-spec.md`: current Nix executor input shape
- `nix/lib/`: normalization and fetch helpers
- `nix/harnesses/`: per-harness package and command selection
- `nix/modules/`: reusable runtime concerns such as locale, Home Manager, and SSH
- `nix/builders/`: final environment, entrypoint, image, and top-level workspace builders

## Build The Example Image

```bash
nix build "path:$PWD/packages/os-integration-nix#example-opencode-home-manager-image"
docker load < result
docker run --rm -it sealant-workspace-demo:opencode
```

## Build The Minimal Example

```bash
nix build "path:$PWD/packages/os-integration-nix#example-minimal-image"
```

## Run The Contract Wrapper Demo

This package also contains a minimal end-to-end wrapper that starts from a
hardcoded user-facing spec, normalizes it through `@sealant/workspace-composition`,
maps it into the current Nix executor spec, and can optionally build through the
existing Nix backend.

Print the hardcoded user spec, normalized blueprint, support result, and mapped Nix executor spec:

```bash
pnpm --filter @sealant/os-integration-nix run demo:user-spec
```

Run the same flow and build the resulting artifacts:

```bash
pnpm --filter @sealant/os-integration-nix run demo:user-spec -- --build
```
