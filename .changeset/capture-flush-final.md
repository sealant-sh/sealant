---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`workspace.capture.flush()` takes options: `flush({ kind: "final", deadlineMs, graceMs })`.
`POST /v1/workspaces/:id/capture/flush` accepts the same fields beside `ownerUserId`. The public
type is `WorkspaceCaptureFlushOptions`.

- `kind: "final"` says the executor is ending. sealantd stops its managed processes, snapshots both
  capture classes, ships, and reports `complete`. After it, the daemon refuses new work.
  `kind: "suspend"` is a checkpoint and stays the default, so `flush()` with no options is
  unchanged.
- `deadlineMs` bounds how long the daemon may take before it answers. A final flush past its
  deadline answers `complete: false` and keeps shipping in the daemon, so later `status()` reads and
  repeated final flushes converge.
- `graceMs` is how long managed processes get between SIGTERM and SIGKILL, inside the deadline.
- Both are positive integers in milliseconds. Absent, the daemon uses its own defaults.

The control plane passes these to sealantd as given. The pinned sealantd (0.18.2) takes no flush
arguments and runs its only flush whatever `kind` says. The fields take effect once the pin moves to
the release that accepts them.

Server-side (the packages ride the release train):

- A drain's FINAL flush asks for a deadline and a grace. The deadline is
  `WORKSPACE_CAPTURE_DRAIN_FINAL_DEADLINE_MS`, capped at the round trip's bound
  (`WORKSPACE_CAPTURE_DRAIN_REQUEST_TIMEOUT_MS`, 60 s) less 5 s. The grace is
  `WORKSPACE_CAPTURE_DRAIN_FINAL_GRACE_MS` (30 s), capped at the deadline.
