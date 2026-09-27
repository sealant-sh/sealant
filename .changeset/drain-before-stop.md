---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace reports when its runtime ends it. `runtime.deadline` on the workspace API
(`GET /v1/workspaces/:id`, the list, the attempts) is the ISO-8601 instant the runtime itself ends
the executor, whatever anyone asks: a Lambda MicroVM's maximum duration from its start. It is `null`
where the runtime imposes no lifetime (Docker, Kubernetes), and absent from control planes that
predate it. The SDK reads it as `workspace.runtimeDeadline()` (`string | null`). A caller holding
unsaved work on the executor drains before it.

A capture-sourced workspace's queue can be read without flushing:
`GET /v1/workspaces/:id/capture?ownerUserId=…` (sealantd `capture.status`), and
`workspace.capture.status()` in the SDK. It answers `pending` (captures not yet saved), `headN` and
`registered` (what the session channel holds), and `refused`: the capture classes (`small`, `bulk`)
the registrar turned away for the session's byte quota. Non-empty `refused` means that work is not
being saved. The flush reply carries `refused` too. `pendingBytes` and `pendingBulk` are reserved
and absent until sealantd reports them. The SDK reads a missing `refused` as nothing refused.

`workspace.stop()` now resolves a `WorkspaceStopResult` (see the drain-ownership changeset for its
states). Callers that ignored the old `void` result are unaffected.

`workspace.ready()` on a handle `workspaces.create()` made requests a stop before it throws
`workspace_ready_timeout`, so a launch nobody will use does not run to the platform's lifetime cap.
The error says whether the stop request was accepted.

Server-side (the packages ride the release train): no platform-initiated stop loses a
capture-sourced workspace's unsaved work. The worker drains the workspace's sealantd before a
lifecycle stop, and before the expired, stranded, superseded and orphaned reapers tear a runtime
down (what counts as drained: see the drain-ownership changeset). A queue still moving defers the
stop to the next sweep. The workspace is kept running, and every sweep asks again, when:

- the daemon answers but its queue does not move for `WORKSPACE_CAPTURE_DRAIN_STALL_WINDOW_MS` (10
  min), logged `not saved · kept`;
- the daemon reports a refused capture class, logged `not saved · refused · kept`;
- the daemon is silent for `WORKSPACE_CAPTURE_DRAIN_UNREACHABLE_WINDOW_MS` (5 min) while the runtime
  reports the executor running, logged `not saved · daemon silent · kept`.

A runtime that reports the executor gone lets a stop proceed without a confirmed drain: there is
nothing left to save. The exit reconciler asks the daemon before it records an exit, and drains a
runtime whose daemon still answers. A MicroVM whose guest Docker failed while sealantd is up is
reported and no longer terminated. A MicroVM ended at its lifetime cap is logged as an error. Docker
stops send SIGTERM first (`docker stop -t`, `SEALANT_DOCKER_STOP_GRACE_SECONDS`, default 120 s), so
sealantd's final flush runs. Kubernetes workspace Pods get `terminationGracePeriodSeconds` from
`SEALANT_K8S_TERMINATION_GRACE_SECONDS` (default 120, was 30).
