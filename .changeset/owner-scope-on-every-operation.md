---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Every owned operation is made for a named owner.

- Reads, listings and changes of workspaces and runs require `ownerUserId` and serve the resource
  only when it belongs to that owner. A call that names none, or another owner, answers the same 404
  as a missing id. This closes the ID-only operations: `PATCH /v1/runs/:runId`,
  `PATCH /v1/workspaces/:id/name`, and the workspace `attempts` and `events` listings took an id and
  nothing else. `updateRun`, `renameWorkspace`, `listWorkspaceAttempts` and `listWorkspaceEvents`
  gain an optional `ownerUserId` on the wire; the control plane requires it.
- `POST /v1/runs` creates a run only in a workspace that belongs to the owner it names. A foreign
  key used to be the only check, so any owner could start a run, executed server-side, in another
  owner's workspace.
- An inference continuation is served only to the owner who opened the exchange; another owner's
  session id answers like one that does not exist. It was addressed by session id alone, on the
  opening owner's credentials.
- The SDK names the owner on every record read. `workspace.exec()` read the timeline and scrollback
  without one. **An SDK older than this release reading records from a control plane with this
  release gets 404s**: upgrade callers together with the control plane, or set
  `SEALANT_REQUIRE_OWNER_SCOPE=false` on the API for the window between the two.
- The SSH gateway's shared secret is now verified by the transport gate (its presence used to be
  enough to pass it) and is its own, narrower authority: key and target resolution, plus creating
  and updating the interactive `ssh` runs of the sessions it carries. The gateway sends it on its
  run recorder calls, which a closed control plane used to answer 401, leaving SSH sessions
  unrecorded.
- The web app makes every control-plane call for the signed-in user, so a workspace or run id from
  another account reads like one that does not exist. Its workspace detail, attempts, events and
  rename routes checked nothing.
