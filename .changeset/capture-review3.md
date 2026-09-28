---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

An idempotent create can be cancelled by its key, and a create names the launch it makes.

- `workspaces.cancelCreate(key)` (`POST /v1/workspaces/idempotency-keys/:key/cancel`) makes sure the
  create with that key never launches. A key that is pending, or that no create has reached yet, is
  cancelled for good: a later create with it, a delayed original request included, is refused with
  409 and `code: "create-cancelled"`, and a create still writing cannot commit. A create that
  already committed answers `found`; stop that workspace instead.
- `workspaces.createState(key)` (`GET /v1/workspaces/idempotency-keys/:key`) answers what became of
  the create: `pending` (started, not committed), `found` (with `workspaceId`, `runId`, `launchId`),
  `cancelled`, or `none`. `none` holds only as of the answer; `cancelCreate` is the answer that
  stays true. An answer the SDK cannot decode fails instead of reading as `none`.
- `WorkspaceConflictError` gains an optional `code`.
- `workspaces.create({ launchId })` names the one executor the create launches. It is recorded with
  the launch and reported as `runtime.launchId`, `workspace.launch.launchId` and the create answer's
  `launchId`.
- `workspace.stop({ completion: { …, launchId } })`: when the create named a `launchId`, an
  attestation must name the same one. One that names another launch, or none, is ignored (a seal
  never transfers between executors). `captureDrain.completion` carries the accepted `launchId`.

Server-side (the packages ride the release train):

- A create's writes (workspace, attempt, link, snapshot, launch job, and its key's commit) are one
  transaction. A repeat that finds a workspace an older create left half-made finishes it instead of
  replaying it forever, and a repeat that finds its launch job still queued publishes it again.
- A launch owns its runtime row under a lease from its first `pending` write until it settles. A
  worker that dies (or is interrupted) after the executor started no longer strands it outside every
  sweep: its lapsed launch is adopted as a retained launch, drained, preserved before its deadline,
  recovered if it ended, and stopped only once its work is confirmed saved.
- The deadline sweep also drives retained executors: a retained launch is drained and stopped, and
  an executor whose daemon exited on a machine that still runs has its recovery made due before the
  cap.
- A MicroVM whose sealantd exited while the VM runs on is recovered on its own disk: the agent
  (`POST /sealant/recover`) kills every process the dead daemon left, then starts
  `sealantd boot --recovery` with the first boot's environment and its secret env file holding the
  capture token kept at launch, and the recovery drains it. An image whose agent predates the route,
  or a disk the recovery boot refuses (an older daemon's), is reported and kept.
- `incomplete_reason: "changed"` (the disk changed after the final flush) is not saved: the drain
  asks for FINAL again, and a complete flush read before it is no longer evidence.
- Recovery restarts an executor in place only when its launch recorded a daemon with sealantd's
  recovery boot (released sealantd 0.19.0 or later, or an image listed in
  `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES`). Any other, or unknown, is kept and reported
  `not recoverable in place`.
- Every removal of an ended capture executor (the exit reconciler's and the Kubernetes orphan
  sweep's included) ends its retention and clears its sealed recovery token.
