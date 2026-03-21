# Workspace Blueprint

`WorkspaceBlueprint` is the normalized, OS-agnostic internal contract owned by
`@sealant/workspace-composition`.

It captures the parts of a workspace request that should survive across OS integrations:

- repository and source inputs
- selected AI harness
- SSH access requirements
- requested symbolic tools and packages
- setup and startup behavior
- runtime defaults and constraints
- target OS preference or requirement

## Shape

The normalized blueprint is defined in `src/blueprint.ts` and parsed with Zod.

Top-level sections:

- `version`
- `sources`
- `harness`
- `access`
- `tooling`
- `lifecycle`
- `runtime`
- `target`

## Defaults

- `version`: `"1"`
- `sources.workspace.kind`: `"git"`
- `sources.workspace.provider`: `"generic"`
- `sources.workspace.ref`: `"main"`
- `sources.inputs`: `[]`
- `access.ssh.enabled`: `false`
- `access.ssh.listenPort`: `2222`
- `tooling.packages`: `[]`
- `lifecycle.setup`: `[]`
- `lifecycle.startup.steps`: `[]`
- `lifecycle.startup.foreground.kind`: `"harness"`
- `runtime.env`: `{}`
- `runtime.workspaceRoot`: `"/workspace"`
- `runtime.workingDirectory`: `"/workspace/repo"`
- `runtime.persistence`: `"ephemeral"`
- `runtime.network.outbound`: `true`
- `target.os.family`: `"auto"`
- `target.os.mode`: `"prefer"`

## Boundary

This blueprint intentionally does not include:

- Nix-specific config such as Home Manager modules or pinned config repos
- distro-specific package names or package-manager details
- image naming, registry publishing, or runtime-adapter deployment settings

Those belong in concrete OS integrations or runtime adapters, not in the shared composition
contract.
