---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A bounded workspace forward can be bound to a session.
`workspace.forward(port, { flow: "bounded", session })` opens only when a process of that session
holds the accepted connection on the workspace's loopback, and its `binding` is
`{ kind: "session", session }`: Core states the binding the workspace runtime verified, never the
one it asked for. A bound forward cannot target the Docker sidecar: `host: "docker"` with `session`
is a type error, also from an options object. Only a bounded forward takes a `session`: the old
overload's options cannot carry one, and a call that passes one anyway rejects with a `SealantError`
(`invalid_options`) and opens nothing.

The open rejects with a `ForwardDialError` whose reason is `owner-exited` (the session is not
running, or has not started yet), `peer-mismatch` (a process outside the session holds the port),
`binding-unverifiable` (the runtime could not tell who holds it) or `binding-unsupported` (the
workspace runtime or the control plane cannot bind forwards; Core asks the runtime before it
connects to anything). Once the session's leader exits, the forward resets with `owner-exited`,
ahead of data Core holds that the caller has not read. The SDK never resolves a forward that asked
for a session without that binding.

`forwardBindingSchema` gains `{ kind: "session", session }`.
