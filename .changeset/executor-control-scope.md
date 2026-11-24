---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A caller can now serve each executor's capture and session sockets. `workspaces.create()` takes
`controlScope`, the directory of the deployment's control root the executor mounts at
`/run/sealant`, so you can bind `capture.sock` and `session.sock` there before the create. It is one
path segment that never starts with `sealant`, and unique for all time: a scope any executor has
held is refused (`409` `WorkspaceConflictError`, `reason` `control-scope-taken` on the SDK's
`SealantApiError`). Launch and recovery never remove the two sockets. Omitted, the scope is the
container name, as before.

`create()` also takes `executorSockets: { capture, session }` for Docker workspaces: `capture` makes
sealantd send captures and presigned object requests to `/run/sealant/capture.sock`, and `session`
lets the workspace's non-root processes reach `/run/sealant/session.sock`. `host-vm` workspaces
relay both sockets on their own. Both options are refused on runtimes with no control scope.

The scope is reported as `runtime.controlScope` on every read, as `controlScope` on the create
answer, and on `capture.replan()` (a standby claim) and `recover()`. `@sealant/api-contracts`
exports the rule (`controlScopeProblem`, `CONTROL_SCOPE_PATTERN`;
`@sealant/api-contracts/control-scope`).
