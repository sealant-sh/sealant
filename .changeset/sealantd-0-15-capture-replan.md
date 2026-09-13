---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`workspace.capture.replan()` (`POST /v1/workspaces/:id/capture/replan`): the daemon asks the session
channel for its plan again with no worktree named, delta-materialises the answer over what is on
disk, and captures under the answered worktree and epoch from then on (the fence lifts, foreign
queue entries drop). The claim hook for a standby executor. Synchronous over the control connection,
idempotent (`unchanged: true`), answered with the worktree id, epoch, optional head sequence and
capture id, and the files and bytes written, skipped and removed. Refused on workspaces that are not
capture-sourced.

Needs sealantd 0.15.0, which also makes materialise a delta over what is on disk and sends
`platform` on `plan.get`; `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.0
and the baked daemon default for workspace images, the MicroVM image and the Cloudflare bridge image
is now `ghcr.io/sealant-sh/sealantd:0.15.0`.
