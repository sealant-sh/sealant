---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Resource instances: a scope (resource domain) runs long-running containers, such as a project's
Postgres or Redis, that its linked workspaces reach by name, with named volumes that outlive every
stop and archive.

The routes are under `/v1/resource-domains/:resourceDomainId` and take a service key, as the other
resource domain routes do. `POST …/instances/:key/up` takes `{ spec, cause }`, creates or updates
the instance by key, starts it and answers it once its ready check passed or its start failed
(`state.kind` `running` or `failed`). `cause: "use"` leaves an instance a person stopped stopped;
`cause: "person"` starts it. `GET …/instances` (`?archived=true` for archived ones) and
`GET …/instances/:key` read them. `POST …/instances/:key/stop` takes `{ by }`, and
`POST …/instances/:key/archive` removes the container and answers every kept volume with its size.
`PUT …/workspace-links/:workspaceId` takes `{ worktreeKey }`: the workspace then reaches the
domain's instances with no worktree key and those with its own, under each instance's alias, across
executor replacements. `POST …/archive` archives every instance and unlinks every workspace.

`POST …/instances/:key/exec` is a raw route: its body is one JSON line (`{ argv, user, timeoutMs }`)
and then the command's stdin, streamed. It answers the exit code and the last 1 MiB of stdout and
stderr. Nothing of the argv or stdin is logged, recorded or carried in a header or query.

A spec has no field for privileged mode, capabilities, host networking, host paths, devices, the
Docker socket or shared namespaces: `400` `ResourceInstanceSpecRefusedError` names each one it is
sent (`decodeResourceInstanceSpec`). Its image must be pinned by digest. A Sealant whose workspaces
do not run on Docker refuses every instance route with `409` `ResourceRuntimeUnsupportedError`
(`resources run on Docker; this Sealant runs <runtime>`).

The SDK reaches them on `sealant.scopes.actAs(id)`: `instances.up(key, spec, { cause })`,
`instances.get`, `instances.list({ archived })`, `instances.stop(key, { kind: "person", by })`,
`instances.exec(key, { argv, user, stdin, timeoutMs })`, `instances.archive(key)`,
`workspaces.link(workspaceId, { worktreeKey })` and `archive()`. Their types are the SDK's own
(`ScopeInstance`, `ScopeInstanceSpec`, `ScopeExecResult`), with dates as `Date`.
