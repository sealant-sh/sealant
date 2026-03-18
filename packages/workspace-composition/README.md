# Workspace Composition

`@sealant/workspace-composition` owns the core workspace composition system.

It defines the shared composition contracts and the OS-agnostic workspace model used before a concrete OS integration is selected.

## Layout

- `docs/contracts.md`: target composition contracts and package boundaries
- `docs/executor-contract.md`: shared OS executor interface and artifact contracts
- `docs/user-workspace-spec.md`: user-facing input contract and normalization rules
- `docs/workspace-blueprint.md`: normalized workspace blueprint contract and defaults
- normalization, selection, and contract code as it lands in this package
- integration-specific build logic now lives in sibling packages such as `packages/os-integration-nix/`

## Target Boundary

The intended layering is:

1. The API or another control-plane surface accepts a `UserWorkspaceSpec`.
2. This package normalizes it into a `WorkspaceBlueprint`.
3. This package selects an OS integration using shared executor contracts.
4. The selected OS integration produces one or more build artifacts.
5. Runtime adapters launch those artifacts on the chosen backend.
