---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A capture-sourced executor's disk is kept until something proves its work saved, and a kept executor
can be recovered.

`workspace.stop({ completion: { captureN, epoch, executorId } })` attests that your capture store
holds a sealed final capture of the workspace's current executor. `POST /v1/workspaces/:id/stop`
takes the same `completion` beside `ownerUserId`.

- `executorId` names the executor. Send the runtime's `resourceId` from
  `workspace.details().runtime`. Its `reference`, or the run id, are accepted too.
- `epoch` is the capture lease epoch the seal was made under. `captureN` is the sealed capture's
  chain position.
- The control plane accepts the attestation only when `executorId` names the current executor and
  `epoch` is not older than any the executor reported. An accepted attestation lets the executor's
  disk go once the executor has ended, even when the control plane never read `complete: true` from
  it itself. An ignored one changes nothing.
- When you send one, the stop's answer and `WorkspaceStopResult` carry `completion`, with `outcome`
  (`accepted` or `ignored`) and, when ignored, `detail`.
- A running executor is still drained first; the attestation never skips that.

`workspace.recover()` (`POST /v1/workspaces/:id/recover`) makes a recovery attempt of the
workspace's retained executor due now. It answers `requested` with `recoverable`, or `not-retained`
when nothing is kept.

`WorkspaceCaptureDrain` (`workspace.details().captureDrain`) gains two optional fields:

- `retained`: the executor is kept because its disk holds work not confirmed saved. It has `since`,
  `reason`, `recoverable`, `recoveryAttempts`, `nextRecoveryAt` and `lastRecoveryError`.
- `completion`: the latest accepted attestation.

A caller can record the executor it launched and find it again:

- `workspace.runtime()` reads the current executor:
  `{ kind, resourceId, reference, status, runId?, deadline }`, or `null` before one is launched.
  `WorkspaceRuntime` on the wire gains `runId`.
- `workspace.launch` is what a handle from `workspaces.create()` knows of its launch:
  `{ runId?, runtime?, replayed }`. `runtime` is the executor `ready()` saw become ready, or, on a
  replayed create, the one that already exists. The create answer (`POST /v1/workspaces`) gains
  `runId`, `runtime` and `replayed`.
- `captureDrain.executor` names the executor an observation is about: `runId`, `resourceId`,
  `reference`, and the runtime (`adapter` on the wire, `kind` in the SDK).
- `workspaces.create({ idempotencyKey })` (the `idempotencyKey` body field, or the `idempotency-key`
  header) is idempotent per owner. A repeated create with the same key answers with the first
  workspace, `replayed: true`, and creates nothing. Another owner's workspace is never returned for
  the same key.
- `workspaces.findByIdempotencyKey(key)` (`GET /v1/workspaces?idempotencyKey=`) finds that workspace
  after a lost answer, or returns `null`.

Server-side (the packages ride the release train):

- Every path that can remove an executor or its disk now asks one preservation policy first: the
  planned stop, the exit reconciler, the Kubernetes orphan sweep, launch adoption and redelivery,
  launch readiness cleanup, the deadline sweep and recovery. A capture-sourced executor, or one
  whose source is unknown, goes only when the control plane observed its final flush complete, the
  caller attested a sealed final capture of it, the owner discarded it, or nothing of it is left. An
  exited executor with no such evidence is kept, whatever its exit code, and so is one whose drain
  record cannot be read. A stop that passes no capture drain still reads the source, and keeps a
  capture-sourced or unknown executor.
- Retention starts when the executor is created, not when it answers readiness. A launch that fails
  after its container, Pod or MicroVM launch push exists keeps it. A redelivered launch that finds
  an ended executor of the same run keeps it instead of replacing it. A capture container is never
  created with `--rm`.
- Retained executors are recorded and retried on a backoff (1 min doubling to 1 h). Docker restarts
  the kept container on its own disk (`docker start`), and a final flush follows at once. The
  executor is removed only after that flush reports complete. The restart boots sealantd in recovery
  mode: the marker `/.sealantd-recovery` is `docker cp`'d into the stopped container first, so no
  lifecycle step, dotfiles or harness runs and nothing is admitted. Its capture token, read once at
  boot from a file removed after readiness, is kept sealed at launch (`capture_token_sealed`,
  cleared when the executor goes) and staged again first. With no token kept, or none the worker can
  unseal, the executor is not started and is reported `not recoverable · no capture token`.
  Kubernetes cannot restart an ended Pod, and its emptyDir lasts only while the Pod object exists,
  so an ended capture Pod is reported and kept. A terminated MicroVM's disk is gone, so only the
  pre-deadline drain protects it.
- The deadline sweep persists a plan for every runtime in its watch window before it drives any
  drain. It then drives every due runtime each tick, earliest deadline first, four at a time. The
  upload estimate counts bytes not yet uploaded, or everything staged when that is unreported. While
  bulk is being built it adds at least the staged size again, or 256 MiB. Until a rate has been
  observed it assumes 1 MiB/s.
- `incomplete_reason: "sealing"` (nothing pending, the seal not yet acknowledged) is handled like
  any empty queue without a complete final flush. The drain asks for FINAL again, never takes it as
  saved, and keeps the executor until the daemon reports `complete`.
- Two drains of one run never overlap, including within one worker: each claim holds the lease under
  its own token.
- The idempotency key is stored on the workspace row, unique per owner, and that row is written
  first. A racing create with the same key fails its insert and answers with the winner. A unique
  violation from Postgres (`23505`) is now recognised; before, only SQLite's wording was, so on
  Postgres a race failed with an internal error.
- A discard is logged as requested before the runtime is ended. It is logged as terminated only
  after the runtime adapter confirms it.
- The MicroVM terminate hook sends `--final` whenever the image's sealantctl offers it
  (`SEALANT_MICROVM_FINAL_FLUSH=0` turns it off). It answers 200 only for a complete final flush. A
  daemon without `--final` gets the ordinary flush, and the hook answers 500.
