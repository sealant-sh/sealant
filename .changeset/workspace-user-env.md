---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Non-secret workspace environment variables on `workspaces.create({ env })`.

The map is validated against a public policy (grammar, size bounds, reserved platform names, and
secret-looking names the workspace runtime would silently drop), lowered into a new strict
`runtime.userEnv` blueprint field, set on the workspace container, and inherited by every process
the platform starts inside the workspace — the harness, later shells, and exec'd commands. Values
are ordinary configuration by contract: they persist verbatim in the durable workspace spec and are
returned by workspace-details APIs; secrets stay on `credentials`. Live workspaces are never
mutated, restarts reuse the stored spec, and caller values can never override platform controls or
injected credentials (caller env is emitted first under docker's last-wins `-e` ordering).

The policy is exported from both packages (`parseWorkspaceEnv`, `findWorkspaceEnvReservedRule`,
`formatWorkspaceEnvIssue`, `WORKSPACE_ENV_*` constants; also importable via
`@sealant/api-contracts/workspace-environment`) so downstream settings surfaces validate with the
platform's exact rules. Legacy `runtime.env` keeps its unrestricted stored-spec semantics and is not
emitted by the SDK; worker-resolved dotfiles clone auth moved off that field onto a transient
adapter launch input and no longer rides any blueprint env map.
