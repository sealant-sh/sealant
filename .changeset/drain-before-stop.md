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

`workspace.ready()` on a handle `workspaces.create()` made stops the workspace before it throws
`workspace_ready_timeout`, so a launch nobody will use no longer runs to the platform's lifetime
cap. The error says whether the stop was accepted.

Server-side (the packages ride the release train): no platform-initiated stop loses a
capture-sourced workspace's unsaved work. The worker flushes the workspace's sealantd and polls its
capture queue until it is empty before a lifecycle stop, and before the expired, stranded,
superseded and orphaned reapers tear a runtime down. A queue still moving defers the stop to the
next sweep. A daemon that answers but whose queue does not move for
`WORKSPACE_CAPTURE_DRAIN_STALL_WINDOW_MS` (10 min) keeps its workspace running and is logged
`not saved · kept`. A daemon silent for `WORKSPACE_CAPTURE_DRAIN_UNREACHABLE_WINDOW_MS` (5 min)
counts as crashed. The exit reconciler asks the daemon before it records an exit, and drains a
runtime whose daemon still answers. A MicroVM whose guest Docker failed while sealantd is up is
reported and no longer terminated. A MicroVM ended at its lifetime cap is logged as an error. Docker
stops send SIGTERM first (`docker stop -t`, `SEALANT_DOCKER_STOP_GRACE_SECONDS`, default 120 s), so
sealantd's final flush runs. Kubernetes workspace Pods get `terminationGracePeriodSeconds` from
`SEALANT_K8S_TERMINATION_GRACE_SECONDS` (default 120, was 30). The workspace SDK's `stop()` still
waits 60 s for `stopped`. A stop that is draining can therefore throw `workspace_stop_timeout` while
the drain finishes on the server.
