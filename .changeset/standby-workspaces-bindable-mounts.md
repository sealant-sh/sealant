---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
"@sealant/workspaces": minor
"@sealant/validators": minor
"@sealant/db": minor
"@sealant/api": patch
"@sealant/worker": patch
---

Standby workspaces and bindable mounts (sealantd ADR-0014, Mend ADR-0001). A workspace can now be
created with `source: { kind: "standby", rootPath }`: the caller-owned root (a project's worktrees
directory) is mounted hidden and the working directory does not exist until
`workspace.bind({ subpath })` points it at one of the root's subdirectories — after the container is
already running, which neither Docker nor Kubernetes allow for a mount. An extra mount declared
`bindable: true` works the same way for its own path, so a project can mount a sibling repository's
worktrees and bind one at `/workspace/repos/<name>`. `POST /v1/workspaces/:id/bind` applies the bind
over the daemon's control connection and records the workspace's live bindings, which every relaunch
re-supplies. Requires a sealantd with `bindMount` (runtime-client 0.13).
