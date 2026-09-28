---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A stop reports only what was observed. `workspace.stop()` resolves `{ state: "stopped" }` once the
runtime is gone. If it is still up after a minute, it resolves what the control plane last observed
of the workspace's capture drain: `{ state: "draining", drain }` while the queue moves,
`{ state: "kept", drain }` when the control plane will not remove the runtime because its work is
not confirmed saved (`drain.detail` says why), and otherwise `{ state: "requested" }`: the stop was
accepted and nothing more has been observed. A capture queue that merely answers is no longer
reported as a drain, and `stop()` no longer throws `workspace_stop_timeout`. `capture` carries the
daemon's queue when it answers. After a readiness timeout, the error says a stop was requested, not
that the workspace stopped.

`GET /v1/workspaces/:id` gains `captureDrain`: `state` (`draining`, `kept`, `saved`, `gone`),
`detail`, `observedAt`, and `preservationStartsAt`, when the control plane starts a drain ahead of
the runtime's deadline. The capture status (`workspace.capture.status()` / `flush()`) gains
`complete` and `incompleteReason`: the daemon's account of its last FINAL flush. Only
`complete === true` means the executor's work is saved. They are absent until sealantd reports them;
read absent as not complete.

Server-side (the packages ride the release train):

- A drain sends a FINAL flush and lets a runtime go only when the daemon reports it `complete`. An
  empty queue is not enough. Until the pinned sealantd reports `complete`, capture-sourced
  workspaces are kept, logged `not saved · not confirmed · kept`, instead of stopped.
- Drain ownership and progress are durable in `workspace_capture_drains`. One worker drains a
  workspace at a time across every worker process, and a dead worker's claim is taken over after
  `WORKSPACE_CAPTURE_DRAIN_LEASE_MS`.
- A run whose workspace source cannot be read is treated as capture-sourced. The source kind is
  recorded on the runtime instance.
- A capture-sourced launch that fails after its executor became ready keeps the executor (error code
  `launch-retained`) and is drained before it is stopped. This applies to Docker, Kubernetes,
  MicroVM, and a runtime row that could not be written. A Kubernetes Pod with no runtime row is
  recorded, not deleted.
- An executor that exits after a final flush it never confirmed complete is left in place. Its disk
  holds the staged captures.
- A runtime with its own deadline gets its final drain and a planned stop early enough to finish:
  `WORKSPACE_CAPTURE_DEADLINE_LEAD_MS` plus an upload estimate from observed throughput and pending
  bytes.
- The MicroVM terminate/suspend hook answers 500 when its flush failed.
- Credentials are read back before the final flush.
