---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Workspace lifecycle close-out: `workspace.stop()`, `workspace.restart()`, and `workspace.expire()`
are real end-to-end operations instead of `SealantNotImplementedError` rejections.

- New control-plane endpoints: `POST /v1/workspaces/:id/stop` (async 202 — the worker removes the
  container and records the terminal `stopped` state), `POST /v1/workspaces/:id/restart` (async 202
  — a fresh launch from the same resolved spec, recorded as a new attempt), and
  `POST /v1/workspaces/:id/expire` (sets, clears, or triggers the workspace TTL).
- `WorkspaceStatus` gains `"stopped"`, and workspace summaries/details expose `expiresAt`.
- `createWorkspace` accepts an optional `ttlSeconds`; the SDK's `create()` accepts `ttl: "2h"`-style
  durations. Expired workspaces are stopped by the platform reaper.
- SDK `stop()` blocks until the workspace reports `stopped`; `restart()` returns a fresh handle
  whose `ready()` gates on the new runtime; `expire({ in: "2h" | null })` sets or clears the TTL.

Compatibility: adding `"stopped"` to the workspace status enum changes the wire contract — older
published SDKs decode workspace responses against the previous five-value literal union and will
fail to decode a stopped workspace. Upgrade the SDK together with the control plane.
