# User Workspace Spec

`UserWorkspaceSpec` is the validated, user-facing input contract accepted before workspace composition produces a normalized `WorkspaceBlueprint`.

It is intentionally more ergonomic than the blueprint and supports small shorthands that are expanded during normalization.

## Supported shorthand

- `source`, `repo`, or `sources.workspace` for the main workspace repository
- `harness: "opencode"` instead of `harness: { id: "opencode" }`
- `ssh: true` instead of `access.ssh.enabled: true`
- `packages: ["nodejs", "pnpm"]` instead of structured package objects
- `setup: ["pnpm install"]` for setup steps
- `startup: "pnpm dev"` for a foreground startup command
- `os: "fedora"` instead of `target.os.family: "fedora"`

## Normalization rules

- exactly one of `source`, `repo`, or `sources.workspace` must be provided
- conflicting alias pairs such as `packages` and `tooling.packages` are rejected
- source providers are inferred from repository URLs when omitted
- package requests are deduplicated by package id
- setup and startup command strings are expanded into structured command steps
- target OS shorthand is expanded into the normalized `target.os` object
- the final result is validated by `workspaceBlueprintSchema`

## Entry points

- `parseUserWorkspaceSpec(input)`: validates the raw user-facing input shape
- `normalizeUserWorkspaceSpec(input)`: validates raw input and returns a normalized `WorkspaceBlueprint`
