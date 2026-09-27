---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A capture-sourced workspace's capture status now carries everything sealantd reports, so a caller
can show a session whose captures are failing. The fields are optional on
`GET /v1/workspaces/:id/capture`, on the `POST /v1/workspaces/:id/capture/flush` answer, and on
`WorkspaceCaptureStatus` from `workspace.capture.status()` and `workspace.capture.flush()`:

- `lastSnapError`, `snapFailingSinceUnixMs`, `snapsFailed`: snaps are failing. While `lastSnapError`
  is present the executor's newest work is not being captured, whatever `pending` says. A path
  longer than `PATH_MAX` once stopped every snap of a session while `pending` read 0.
- `unreadable`, `carried`, `unreadablePaths`: paths the last snap could not read, how many of them
  kept their last captured content, and the first 20 of them (`tree/…`, `.git/…`, `harness/…`).
- `registerRefused` (`missing-objects` or `unrestorable`), `registerRefusedN`, `registerMissing`,
  `registerRefusals`, `repairing`: a capture the registrar would not register, which the executor
  uploads again and rebuilds from disk. Nothing is dropped.
- `bulkBuilding`: a bulk capture is still being built and is not counted in `pending` yet.

A field sealantd does not report stays absent. It is never filled with a default. The control plane
pins sealantd's wire at 0.18.2, which carries none of these, so every one of them stays absent until
that pin moves to a release that reports them. The snap-failure names are provisional: sealantd has
not published them yet.

Server-side (the packages ride the release train): a drain logs a failing snap as an error once per
distinct error, and every keep it records names the error. The stored drain status keeps every
field.
