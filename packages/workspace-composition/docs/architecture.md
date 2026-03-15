# Architecture

The workspace composition library is built around one core rule: keep request-specific data separate from reusable builder logic.

## Flow

1. A control-plane layer normalizes user input into a spec.
2. `normalize-spec.nix` fills in defaults and validates the shape.
3. The builder resolves packages, harness selection, and optional external config repositories.
4. Reusable runtime modules contribute pieces of behavior such as:
   - locale setup
   - Home Manager activation
   - SSH bootstrap
   - metadata emission
5. The entrypoint script stitches those pieces together.
6. The final image is produced with `dockerTools.buildLayeredImage`.

## Build-Time vs Runtime

- Build time:
  - package resolution
  - harness binaries
  - pinned config repository fetches
  - Home Manager activation package generation
  - metadata files
- Runtime:
  - repo cloning
  - SSH host key generation
  - foreground command overrides
  - first-run editor/plugin shims

This split keeps image generation reproducible while still allowing each launched workspace to target a different repository.
