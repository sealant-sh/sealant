---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A capture-sourced workspace's capture status now carries everything sealantd reports, so a caller
can show a session whose captures are failing. The fields are optional on
`GET /v1/workspaces/:id/capture`, on the `POST /v1/workspaces/:id/capture/flush` answer, and on
`WorkspaceCaptureStatus` from `workspace.capture.status()` and `workspace.capture.flush()`:

- `snaps`: one entry per captured class, with `class` (`small` or `bulk`), `snapsFailed` (failed
  snaps since the daemon started), and, while that class's last snap failed, `lastSnapError` and
  `snapFailingSinceUnixMs`. A snap that fails stages nothing, so the changes since the last capture
  exist only on the executor's disk. A path longer than `PATH_MAX` once stopped every snap of a
  session while `pending` read 0.
- `lastSnapError`, `snapFailingSinceUnixMs`, `snapsFailed`: flat fields derived from `snaps`, for a
  caller that shows one error. They hold the error of the class that has been failing longest, the
  earliest start, and the sum of failed snaps. While `lastSnapError` is present, the newest work is
  not being captured.
- `unreadable`, `carried`, `unreadablePaths`: paths the last snap could not read, how many of them
  kept their last captured content, and the first 20 of them (`tree/…`, `.git/…`, `harness/…`).
- `registerRefused` (`missing-objects` or `unrestorable`), `registerRefusedN`, `registerMissing`,
  `registerRefusals`, `repairing`: a capture the registrar would not register, which the executor
  uploads again and rebuilds from disk. Nothing is dropped.
- `bulkBuilding`: a bulk capture is still being built and is not counted in `pending` yet.

`incompleteReason` documents every reason sealantd gives, including the new `in-progress`: a final
flush is still running.

A field sealantd does not report stays absent. It is never filled with a default. The control plane
pins sealantd's wire at 0.18.2, which carries none of these, so every one of them stays absent until
that pin moves to a release that reports them.

Server-side (the packages ride the release train): a drain logs a class whose snaps fail as an error
once per distinct error, and every keep it records names each failing class and its error. The
stored drain status keeps every field.
