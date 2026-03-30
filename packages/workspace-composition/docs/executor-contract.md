# Executor Contract

`OsExecutor` is the shared interface that OS-specific backends implement so the composition layer
can call them uniformly.

The first concrete backends now live in `@sealant/sandboxes` for Arch, Fedora, and Nix.

## Responsibilities

- declare the concrete OS family the backend targets
- report whether a normalized `WorkspaceBlueprint` is supported
- compile a supported blueprint into one or more standardized build artifacts

## Type-level interface

The runtime contract is defined in `src/executor.ts` as the `OsExecutor` TypeScript interface:

- `id`
- `osFamily`
- `supports(input)`
- `compile(input)`

## Zod-backed schemas

`@sealant/workspace-composition` also exports Zod schemas for the data that flows through the
interface:

- `osExecutorIdSchema`
- `osExecutorSupportSchema`
- `osExecutorCompileInputSchema`
- `buildArtifactSchema`
- `osExecutorCompileResultSchema`

Each schema also exports a corresponding type using `z.infer<...>`.

## Standardized output

Executor compile results currently support these artifact kinds:

- `oci-image`
- `filesystem-closure`
- `manifest`
- `metadata`

That gives runtime adapters a stable handoff point without baking in Nix-specific or distro-specific
result formats.
