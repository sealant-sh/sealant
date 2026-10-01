# @sealant/api-contracts

## 0.38.1

### Patch Changes

- 2b78985: Claude and Codex logins have one refresher. Workspaces and inference calls get a copy that cannot
  refresh (Claude's file without its refresh token, Codex's `auth.json` with a placeholder), so no
  copy can rotate, spend or revoke the stored login. The worker refreshes each login through the
  official CLI (Claude an hour before its access token expires, Codex a day before, one refresh per
  login at a time across workers) and writes the new copy into every running workspace launched with
  it; Claude Code and Codex pick it up without a restart. A refused refresh marks the account invalid.
  Workspaces launched before this still have their rotations read back until they end.
- 488a5a7: The worker handles up to four run-exec deliveries (harness runs and workspace execs) at once
  (`RUN_EXEC_QUEUE_CONCURRENCY`, default 4). They shared the build queue's single slot
  (`WORKSPACE_BUILD_QUEUE_PREFETCH`, default 1), so one slow exec (a cold binary read, an executor
  that is gone) held every other workspace's setup and harness start for minutes.

## 0.38.0

### Minor Changes

- c8c9c7b: A retained executor reads `retained`, and the drain and retention can be read without a stop.

  - Workspace status and runtime status gain `retained` (`workspaceStatusSchema`,
    `workspaceRuntimeSchema.status`; SDK `WorkspaceStatus`, `WorkspaceRuntimeInfo.status`): the
    executor ended — or its capture launch failed after it started — with work on its disk not
    confirmed saved. It is kept, not dead: the control plane drains or recovers it with the capture
    token it was launched with, and the status reads `stopped` or `failed` again only once that ends.
    Keep the session's lease and token while it reads `retained`. An SDK that predates the value fails
    to decode such a workspace rather than reading it as ended.
  - `ready()` fails at once on `retained`; `stop()` of a retained workspace answers `kept` with the
    drain at once (unless it discards, or its completion attestation was accepted).
  - `workspace.captureDrain()` reads the drain and retention as last observed (state, retained and its
    recovery, the accepted completion, the executor it is about) without stopping anything; `null`
    when nothing was observed, which says nothing about whether the work is saved.
  - `captureDrain.executor.launchId`: the launch identity the create named for that executor.

  Server-side (the packages ride the release train): a retained executor's recovery starts the moment
  it is retained and is retried after 10 s, doubling (`WORKSPACE_RECOVERY_SWEEP_INTERVAL_MS`, 5 s);
  one stop of a capture executor at a time (a second finds the drain claim held and leaves it); a
  drain of an executor that ended ends at once; an ended retained executor's Docker sidecar is
  stopped; every capture executor bounds its shutdown final flush inside its stop grace
  (`SEALANT_SHUTDOWN_FINAL_DEADLINE_MS`); a launch whose worker died before it recorded its executor
  is found by its run, or ended `launch-lost` when nothing started (`WORKSPACE_LAUNCH_LEASE_MS`, 2
  min); saved means `complete` with no `incompleteReason` (`unwatched` and unknown reasons ask for
  FINAL again).

- 206abab: `workspace.capture.flush()` takes options: `flush({ kind: "final", deadlineMs, graceMs })`.
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

- 878e2ee: A capture-sourced executor's disk is kept until something proves its work saved, and a kept executor
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

- dd4e856: An idempotent create can be cancelled by its key, and a create names the launch it makes.

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

- 0e31ee0: A completion attestation carries the seal's time, and a newer observation that the work is not saved
  revokes an older seal.

  - `stop({ completion: { sealedAt } })` (`StopWorkspaceRequest.completion.sealedAt`, ISO 8601,
    optional): when the store recorded the seal. The control plane weighs the attestation against its
    own observations of the executor, when it is accepted and again whenever it is used: an older
    epoch, a capture past `captureN`, or — in the same epoch — a report that the work is not saved
    (incomplete, changed, unreadable, a failed snapshot) that did not come before the seal (its head
    short of `captureN`, or read more than 60 s before `sealedAt`) makes it `ignored`. Without
    `sealedAt`, any such report at or past `captureN` does. A seal stands in for a lost FINAL answer,
    never for a received one that said the work is not saved. An unparseable `sealedAt` is ignored.
  - `captureDrain().completion.sealedAt` reports it back.

  Server-side (the packages ride the release train): recorded evidence (an earlier complete flush, an
  attestation) removes only an executor that ended; a running one is drained (FINAL) first, the
  retained-executor recovery included. A kept executor's retention and its terminal write commit in
  one transaction, and every sweep looks again at an ended capture executor nothing settled. A launch
  still pending when its runtime's preservation start arrives is taken from its worker and drained,
  and a launch never waits for readiness past that start (`WORKSPACE_CAPTURE_DEADLINE_LEAD_MS`). The
  MicroVM agent spares, in a recovery and in the list it hands sealantd (`SEALANT_SWEEP_EXEMPT_FILE`),
  only the processes it started itself, by pid and start time — never by name — and stops the guest
  Docker service before a recovery boot. Migration `capture_attestation_freshness`.

  Also server-side: every capture executor boots with `SEALANT_CAPTURE_LAUNCH_ID` when the create
  named a launch; `store-fidelity` is never saved; a FINAL whose connection closes under it (its sweep
  stops the relay) is read again rather than reported as refused, in the flush route and in every
  drain; a Docker recovery starts the workspace's parked Docker sidecar first; and an executor whose
  recovery boot finds nothing to save (sealantd exit 76: it never materialized) is released with the
  daemon's words recorded.

- 6219580: Capture evidence is ordered by the executor's own history, never by clocks.

  - `WorkspaceCaptureStatus.origin` (optional, from `capture.status()` and `capture.flush()`): where
    in the executor's own history the answer was made —
    `{ epoch, launch, bootId, bootGeneration, observation, headN? }`, sealantd's stamp (wire fields
    27–30). Of the same epoch, launch and boot, order by `observation`; of the same epoch and launch
    and different boots whose generations are both above 0 and differ, by `bootGeneration` then
    `observation`; anything else cannot be ordered and must fail closed. Absent from a daemon that
    predates the stamp.
  - `stop({ completion: { origin } })` (`StopWorkspaceRequest.completion.origin`, optional): the
    seal's position (the `final_seal`'s stamp). The control plane places a report that the work is not
    saved before the seal only by the executor's history (its head short of `captureN`, or its
    `origin` before the seal's); `sealedAt` is kept for display and no longer orders anything. Without
    `origin`, any such report at or past `captureN` revokes the seal. The accepted attestation reads
    back with its `origin` on the workspace's `captureDrain.completion`.
  - A FINAL relayed by `capture.flush({ kind: "final" })` whose answer is lost, whose status is read
    again, and whose repeated FINAL loses its answer too now returns the last status the daemon gave,
    not the transport error: a received "not saved" is never turned into a lost answer.
  - `capture.status()` and `capture.flush()` fail (500) without asking the daemon when the control
    plane cannot mark the observation in flight; an answer it receives but cannot record is still
    returned, and the executor it came from is kept until a later observation is recorded.

- 206abab: A capture-sourced workspace's capture status now carries everything sealantd reports, so a caller
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

- cbd6bf5: A workspace reports when its runtime ends it. `runtime.deadline` on the workspace API
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

- 206abab: `workspace.stop({ discardUnsaved: true })` (`POST /v1/workspaces/:id/stop` with
  `discardUnsaved: true`) ends a workspace without saving its unsaved captures. The stop skips the
  drain, the runtime is terminated at once, and the request is recorded. It is the owner's only way to
  end a capture-sourced workspace that the control plane keeps because its work cannot be confirmed
  saved. It is accepted on a workspace whose stop was already recorded. It is owner only and
  irreversible. The workspace's `captureDrain` then reads `discarded`, with
  `discard: { requestedBy, requestedAt }`. `captureDrain.state` also reads `stop-failed` when removing
  the runtime failed (the control plane retries it) and `stopped` once the runtime was removed after
  its drain.

  Server-side (the packages ride the release train):

  - Every Docker workspace container is created with its own stop timeout (`--stop-timeout`), so a
    plain `docker stop` from an operator, a host restart or Docker Desktop quitting waits for
    sealantd's final flush instead of killing it after 10 s. The timeout is
    `SEALANT_DOCKER_STOP_GRACE_SECONDS` (120 s), or `SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS` (3600
    s) for a capture-sourced workspace. Docker's own `shutdown-timeout` still bounds a daemon
    shutdown.
  - Kubernetes capture-sourced Pods get `terminationGracePeriodSeconds` from
    `SEALANT_K8S_CAPTURE_TERMINATION_GRACE_SECONDS` (3600).
  - Recording a run's changes no longer restages the workspace's git index. The diff is staged in a
    throwaway index, and the user's index keeps its exact bytes. This covers the worker's run exec and
    the SSH gateway's interactive runs.
  - A stop records that it is under way before the runtime is asked to go. An exit observed after that
    is recorded as the planned stop (`stopped`), never `failed`.
  - A stop whose launch-material cleanup fails still completes.

- 206abab: A stop reports only what was observed. `workspace.stop()` resolves `{ state: "stopped" }` once the
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

### Patch Changes

- a815ca9: An executor whose status request was cut off no longer waits out the request's whole fence before
  a complete FINAL can release it. Before, when a caller of `capture.status()` or `capture.flush()`
  went away, or a deadline sweep's bounded read ran out, while the answer was being recorded, that
  observation stayed in flight for up to 56 minutes. Every stop in that window kept the executor, even
  after it answered `complete`.

  The control plane now always records an answer it received, whoever interrupts. An answer it cannot
  record ends its observation at once, because no answer can arrive after the request is over. The
  next observation of that executor then settles it. An observation whose request is still out is
  honoured as before: nothing is removed while its answer could still arrive unrecorded.

- 44653fd: A retained executor's recovery and a removal from another path can no longer overlap. Recovery
  starts an executor only under its own live recovery claim. While that claim is live, no other path
  can remove the executor; only the recovery attempt that holds the claim can. Another path decides
  again once the claim is released or lapses.
- 44653fd: A removal issued again after its first request's outcome was lost now checks the evidence again
  right before it asks the runtime. Before, only the handover checked it, so an answer published
  between the handover and the call could not stop a second request. Now that answer refuses the call.
  The first request stays issued and keeps observation and recovery closed until the runtime shows its
  outcome.
- 44653fd: A rolling deploy can no longer weaken the capture ledger's guarantees. While older and newer
  control-plane processes run side by side, the database now enforces the ledger's rules for writes
  from older processes. An older process that replaces a status keeps the replaced answer on record if
  the work was not saved, so an earlier seal cannot stand again. An older process can no longer give
  up a removal it already issued; only the removal's outcome ends it. It can no longer send a removal
  again after the evidence changed, or authorize one while a recovery attempt holds the executor. It
  also no longer finds a claimed executor due for recovery, so it cannot start a second recovery
  beside the first. Apply the migration before starting the new processes.
- 44653fd: A MicroVM termination is sent once and never retried inside the call. Before, the AWS SDK could
  retry a termination whose first request reached the platform and lost its reply, and a refusal of
  the retry was read as proof that nothing had been removed. The removal was then given up while the
  first request could still act. A refusal now ends a removal only when it answers the call's only
  request and is an error the platform documents as not acting. Any other failure leaves the removal
  issued until the runtime shows its outcome.
- e671cbd: During a rolling deploy, an older control-plane process can no longer remove an executor while an
  answer that says its work is not saved is on record. The database already kept such answers for
  newer processes, but an older process reads only the latest status, which can look covered by a
  seal. The database now refuses an older process's removal while any unsaved answer is on record, and
  the older process keeps the executor. Newer processes weigh those answers themselves and are not
  affected.
- e671cbd: Capture status and flush answers now carry `overdue` when a capture step on the executor is running
  past its bound: the step, when it started, how long it has been running and its bound. The field
  comes from sealantd's `CaptureStatusReport.overdue` and reaches SDK callers as
  `WorkspaceCaptureStatus.overdue`. It is absent while nothing is past its bound, and from older
  daemons. It reports a stuck step and is not a verdict; the step's own limit ends it.
- e671cbd: A refused removal request no longer cancels an earlier one that may still act. Core now records
  every request it sends to remove an executor, each with its own outcome. When a request sent again
  is refused, only that request is settled. If an earlier request's outcome is still unknown, the
  removal stays issued, so the executor is not observed or recovered. It stays that way until the
  runtime no longer has the executor, or until the runtime's bound on every unknown request has
  passed. Requests sent by older control-plane processes during a rolling deploy are recorded by the
  database. Apply the migration before starting the new processes.
- 7aa048f: During a rolling deploy, the control-plane release immediately before this one can no longer give up
  an executor's removal while an earlier removal request, one the runtime may have accepted, has no
  known outcome. That release already marked itself as a current writer of the capture ledger, so the
  database let it through, though it didn't track each request's outcome. The marker now carries the
  ledger contract's version, and the database holds every writer with another version to the older
  rules. For every writer, the current one included, the database also refuses to end an issued
  removal, other than as removed, while any request it sent has an unknown outcome.
- f139a21: Removing a capture executor is now an owned transition. Once the control plane authorizes the
  removal on the evidence it holds, `capture.status()` and `capture.flush()` for that workspace fail
  (500) without asking the daemon, until the removal is released or completes. After the executor is
  removed they keep failing. Nothing received after that authorization can come too late to be
  weighed. A status recorded anyway voids the removal, and the control plane decides again on the new
  evidence.
- d4ec29c: Once the runtime has been asked to remove a capture executor, `capture.status()` and
  `capture.flush()` for that workspace keep failing (500) without asking the daemon until the outcome
  is known. This holds even if the worker that asked stops renewing its hold, because the request
  cannot be withdrawn. If that worker is gone, the control plane checks the runtime. If the executor
  is gone, it is recorded removed. If it is still there and the evidence has not changed, the removal
  is issued again. If the evidence changed, the removal is dropped and the control plane decides
  again. A status recorded in the meantime is kept as evidence and no longer cancels a removal already
  issued. The deadline sweep now releases an executor's FINAL slot as soon as its FINAL is answered,
  so a slow removal of one executor no longer delays another's first FINAL or the next sweep.
- ba6cc76: A seal must cover every unsaved answer an executor gave. Before, the control plane kept only the
  latest status, so an older answer that arrived late could erase a newer failure and bring an old
  seal back. The control plane now keeps every unsaved answer that no later answer covers. A stop's
  `completion` attestation is `ignored` unless its seal covers all of them. An executor reads saved
  only once each one is covered by an answer or a seal.

  A removal the runtime was asked to make no longer ends when its call fails with an unknown outcome,
  for example a lost reply. Until the outcome is known, `capture.status()` and `capture.flush()` keep
  failing without asking the daemon, and the executor is not recovered. Only the runtime's own
  refusal, the executor being gone, or the runtime's bound on the request having passed ends it. On
  MicroVM that bound is 19.5 minutes: the terminate calls are bounded and AWS accepts a signed request
  only within 15 minutes of signing.

  Retained executors are now recovered independently, the one whose runtime ends soonest first. Every
  call of a recovery attempt is bounded, and only one attempt runs per executor at a time. The
  deadline sweep starts an urgent recovery itself instead of waiting for the recovery sweep. It
  reports a removal as under way only after the removal was issued.

- ab5af90: Workspaces run sealantd 0.19.0. A capture flush now sends its kind (final or suspend), deadline and grace to the daemon, so a stop's final flush is a real FINAL, and every status field a 0.19.0 daemon reports (completion, the executor-origin stamp, the overdue step) reaches the SDK.

## 0.37.2

### Patch Changes

- f85ccbf: Six more workspace package ids (server-side; the packages ride the release train): `starship`,
  `zsh-autosuggestions`, `zsh-syntax-highlighting`, `zsh-history-substring-search`, `direnv` and
  `eza`, on fedora, arch, ubuntu and nix. Each is the family's repository package where there is one.
  Fedora 41 and Ubuntu 24.04 package neither `starship` nor `zsh-history-substring-search`: there
  `starship` is its pinned 1.26.0 release and the plugin is its 1.1.0 tag, checked by SHA-256 and
  installed to `/usr/local/share/zsh-history-substring-search/`. The reference page lists where each
  plugin's `.zsh` file lands on each family.

  `POST /v1/workspaces` keeps the package ids a request names. It used to rewrite them to one family's
  package names (`python` to `python3`, `github-cli` to `gh`) after checking them against the catalog,
  and the image planner, which takes catalog ids, then refused the rewritten names: every nix, Fedora
  and Ubuntu workspace that asked for `python` or `github-cli` failed to build. The rewrite also
  refused ids its own map lacked on a family (`mise` on Fedora), and dropped a requested version.

## 0.37.1

### Patch Changes

- b7731e1: sealantd 0.18.2 (daemon image only; the packages ride the release train). Dotfiles `manager: auto`
  picks stow only for a stow layout, so a home mirror (`.config/`, `.zshenv` beside plain directories)
  is copied with its dot entries instead of stowed without them; `HOME` is set for every apply, and an
  arm64 loader shim is included (sealant-sh/sealantd#96). The baked daemon default for workspace
  images and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.18.2`, and
  `@sealant/runtime-client` and `@sealant/runtime-protocol` move to `^0.18.2`.

## 0.37.0

### Minor Changes

- 9672849: A catalog for workspace packages (server-side; the packages ride the release train). Each package id
  a blueprint may ask for now has an entry per managed OS family: the family's repository package
  where there is one, or a pinned upstream release (one archive per architecture, its SHA-256 checked
  before anything is unpacked) where there is not, plus the link where a repository installs a binary
  under another name. Until now an id the family map did not know was handed to the package manager as
  is, and Mend's default list only existed on Arch x86_64: Fedora 41 has no `mise` or `lazygit`,
  Ubuntu 24.04 also lacks `uv` and `pnpm`, both call the GitHub CLI `gh`, and Arch Linux ARM lacks
  `mise`. Every id in Mend's default list now installs on fedora, arch, ubuntu and nix, on x86_64 and
  ARM64.

  An id the catalog does not know is refused when the image is planned, and `POST /v1/workspaces`
  refuses it as a 400 naming the id and the catalog, rather than failing minutes into a build. A
  custom base image still takes any name its own package manager knows.

### Patch Changes

- 9d208e3: An Arch image build fails at the package step when pacman cannot install a package (server-side;
  the packages ride the release train). The step was rendered as `pacman -Syu && pacman -S … &&
pacman -Scc || true`, so the `|| true` meant for the cache clean covered the whole chain: a package
  pacman could not find passed the step with nothing installed, and the build died steps later on a
  missing `npm`, with the real cause buried in the log. Seen on Arch Linux ARM on 2026-09-21, where
  `mise` is not packaged. The `|| true` now covers the cache clean alone.

## 0.36.1

### Patch Changes

- 59ebed3: Workspace-scoped Docker in a Lambda MicroVM on every managed OS family, proven live (server-side;
  the packages ride the release train). Each family's image carries the Docker engine and the packages
  it needs when the blueprint asks for `tooling.services.docker`, nix included, which had no Docker
  line at all. Three faults in the families' recipes, found by that proof and fixed for every runtime:
  Docker Hub's `archlinux` image is x86_64 only, so an Arch image on ARM64 now starts from Arch Linux
  ARM's signed rootfs, verified against the port's build key; the nix image has no FHS dynamic loader
  path, so no native harness binary (codex, claude, opencode) could start on it, and its package layer
  now links glibc's loader into `/lib` and `/lib64`; and a recent npm skipped opencode's postinstall,
  which fetches its binary, so that install now allows it. The worker image copies every file of
  `microvm-image/`, the Arch signing key among them.

## 0.36.0

### Minor Changes

- 9acbe11: A Lambda MicroVM workspace boots the image built from its blueprint (server-side; the packages ride
  the release train). Until now the MicroVM adapter booted one hand-registered image for every
  workspace, so a blueprint's OS family, base image, packages and shell did nothing there, and the
  container image the worker built for the run was never used.

  Each runtime is now registered with the builder of the image it boots. MicroVM gets one of its own:
  it takes the Containerfile planned for the blueprint, puts the in-VM agent on top, and has AWS's
  managed image build run it under a build role. No recipe step runs on the control plane, and a
  worker that serves only MicroVMs needs no Docker and no registry. One plan is one image, named
  `sealant-ws-<plan hash>` and reused by every workspace with that plan. A cap
  (`SEALANT_MICROVM_MAX_IMAGES`, 50) refuses to build past it and says so, and the worker's image
  retention deletes the ones nothing uses. Images are told by name, so two control planes that share
  an AWS account set different `SEALANT_MICROVM_IMAGE_NAME_PREFIX` values.

  Breaking for a MicroVM deployment. `SEALANT_MICROVM_IMAGE_ARN`, `SEALANT_MICROVM_IMAGE_VERSION`,
  `SEALANT_MICROVM_DOCKER_IMAGE_ARN` and `SEALANT_MICROVM_DOCKER_IMAGE_VERSION` are retired, and the
  API and worker refuse to start while one is set. Set `SEALANT_MICROVM_BUILD_ROLE_ARN` (it now
  enables the adapter) and `SEALANT_MICROVM_ARTIFACT_BUCKET` on the worker. Workspace-scoped Docker is
  `SEALANT_MICROVM_DOCKER_ENABLED` on the API and worker, off by default, because such an image is
  created with the `ALL` OS capability. A recipe step can obtain the build role's credentials, so give
  that role `s3:GetObject` on the artifacts prefix and the two log actions only. The worker needs the
  four `lambda:*MicrovmImage` actions, `iam:PassRole` on the build role, and `s3:PutObject` /
  `s3:DeleteObject` on the prefix. `microvm-image/build-image.sh` and its Dockerfiles are removed.

  Needs a sealantd release whose image ships `sealantctl` (sealant-sh/sealantd#94): the recipe copies
  it from beside the daemon, for the capture flush in the suspend and terminate hooks.

### Patch Changes

- be6dcd4: Two faults in the MicroVM image builder, found by its first run against AWS (server-side; the
  packages ride the release train). It looked images up and deleted them by name, where the platform
  takes an image ARN, so every build failed at its first lookup with "Invalid ARN format". And it sent
  the plan hash as the create request's `clientToken`: a plan built again after its image was deleted
  replayed a token the platform had already completed, and that create sat in `CREATING` for the whole
  build timeout with no build running. The name is now completed to an ARN from the build role's
  account, and the token is one per build attempt. An opt-in live spec
  (`SEALANT_MICROVM_BUILT_IMAGE_E2E=1`) builds a customised blueprint, boots it and checks inside the
  VM.
- 679caa3: sealantd 0.18.1 (daemon image only; the packages ride the release train). The released daemon image
  now ships `sealantctl` beside `sealantd` and `socat` (sealant-sh/sealantd#94). The MicroVM image
  builder copies it into every workspace image, because the in-VM agent runs
  `sealantctl capture flush` in the platform's suspend and terminate hooks. Against 0.18.0 that copy
  fails and no MicroVM image builds. The baked daemon default for workspace images and the Cloudflare
  bridge image is now `ghcr.io/sealant-sh/sealantd:0.18.1`, and `@sealant/runtime-client` and
  `@sealant/runtime-protocol` move to `^0.18.1`. No daemon behaviour changed.

## 0.35.1

### Patch Changes

- 8a0e88e: Needs sealantd 0.18.0 (sealant-sh/sealantd#91, #93). The repository of a capture-source workspace
  gets the remotes its control plane names: `plan.get` may answer `remotes` (a name and a URL each),
  and the daemon sets them after it materializes the head, at boot and at every `capture.replan`. The
  daemon builds that repository itself, so until now it had none, and `git push origin` or
  `git fetch origin` failed inside every captured session with "'origin' does not appear to be a git
  repository". A registrar that answers no `remotes` is unchanged. The daemon also sends the reply to
  `runtime.gracefulShutdown` before it exits: the Unix control frontend now joins its live
  connections, where the reply used to race the process exit and the client saw its connection close.

  Daemon-only, with no new API surface. `@sealant/runtime-client` and `@sealant/runtime-protocol` move
  to ^0.18.0, and the baked daemon default for workspace images, the MicroVM image and the Cloudflare
  bridge image is `ghcr.io/sealant-sh/sealantd:0.18.0`.

## 0.35.0

### Minor Changes

- 6a668f5: A connected account reports how fresh its credential is. `ConnectedAccountSummary` gains a
  `credential` object with `accessExpiresAt`, `refreshExpiresAt`, `lastRefreshAt` and
  `lastRefreshOutcome` (`refreshed`, `fresh` or `failed`), and the SDK's `ConnectedAccount` carries it
  through.

  Every field is null when nothing was observed: a setup token has no expiry, a row connected before
  this shipped has no stored one, and an account the keep-fresh sweeper has never touched has no
  outcome. The numbers come from the non-secret metadata mirror and the account's own columns, so the
  sealed payload stays sealed and a consumer gets an observation rather than a guess.

  Two smaller changes make that possible: a Claude credentials file now records its
  `refreshTokenExpiresAt` beside the access expiry it already recorded, and the keep-fresh sweeper
  records what each sweep did. A consumer can now tell someone their grant expires on the 15th, or has
  expired, before a harness fails to authenticate rather than after.

### Patch Changes

- effb7c2: A Claude credentials file is stored as its `claudeAiOauth` grant alone. The file Claude Code writes
  is `{ claudeAiOauth, mcpOAuth }`, and the `mcpOAuth` half holds refresh tokens for whichever MCP
  servers the person authorized on their own machine. Connecting stored the document whole, so those
  third-party tokens reached the control plane's database and every workspace that attached the
  account; a rotated file read back by the sync-back worker could bring them back again.

  Both ends now narrow: `POST /v1/connected-accounts` seals the grant and records the sections it left
  out as `metadata.droppedSections`, and the workspace sync-back drops an `mcpOAuth` section a
  rotation hands back. Nothing about the grant changes, so a workspace's Claude Code still has the
  refresh token it rotates with, and a document with nothing to drop is stored byte for byte as it
  arrived. A client that narrows before sending sees no difference; one that does not is stored narrow
  anyway.

## 0.34.0

### Minor Changes

- 6e089f5: Per-credential and per-owner budgets. `BudgetExceededError` (HTTP 429, with `budget`,
  `limit` and `retryAfterSeconds`) joins the errors of `createWorkspace`, `restartWorkspace`,
  `createRun` and inference `respond`; the transport gate answers the same shape, with
  `Retry-After`, when one credential exceeds its request rate (`Retry-After` is set there only;
  handler refusals carry `retryAfterSeconds` in the body). A budget refuses new work and never stops
  running work. A ceiling is checked before the work is created, so creates that race can overshoot
  it by the number in flight.

  - `SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE` (12000: one service key is a whole product) and
    `SEALANT_BUDGET_OWNER_LAUNCHES_PER_MINUTE` (120), counted per API process.
  - `SEALANT_BUDGET_OWNER_LIVE_WORKSPACES` (100) and `SEALANT_BUDGET_OWNER_ACTIVE_RUNS` (100), read
    from Postgres. A launcher that keeps standby workspaces warm per owner should size the first to
    its pool.
  - `SEALANT_BUDGET_OWNER_INFERENCE_TOKENS_PER_DAY` (off). Usage is now recorded per owner per UTC
    day in a new `inference_usage` table (migration `20260917211231_inference_usage`: counts only).
  - `SEALANT_BUDGET_RUN_OUTPUT_BYTES` (1 GiB) on the worker: past it, output chunks keep their event
    rows and lose their bytes, and the record carries one loss span where stored content ends.

  `0` turns a budget off, and the API logs at start which are off.

- 613376c: Credentials are bound to the destination they were issued for.

  - A client-supplied `authRef` is now checked against its source URL: the installation token is
    minted only for `https://<GitHub host>/<owner>/<name>[.git]` of the repository the ref stands
    for. A grant on one installation could previously attach its token to a clone of any URL. A
    restart checks the recorded spec the same way and answers 409 when it names another destination,
    and server-minted sources use the GitHub host the install talks to, so reruns pass on GitHub
    Enterprise Server.
  - `WorkspaceCaptureSource.transport` (`plaintext`, `channelCaPem`, `objectCaPem`) tells the
    workspace daemon how to dial the session channel and its object URLs. It needs a daemon with the
    capture transport policy (sealant-sh/sealantd#86); an older daemon ignores it. Without
    `transport` that daemon requires HTTPS with a publicly verifiable certificate and refuses to
    boot otherwise, so **a launcher that reaches its channel over plain HTTP on a private network
    must now send `transport: { plaintext: true }`**. The Cloudflare runtime does not support
    `transport`, and the control plane says so at create.
  - The control plane refuses a capture endpoint that is not `http(s)`, embeds credentials, is plain
    HTTP beyond loopback without `transport.plaintext`, or falls outside the operator's
    `SEALANT_CAPTURE_ALLOWED_ENDPOINTS`. `SEALANT_CAPTURE_REFUSE_PLAINTEXT=true` vetoes plain HTTP
    whatever a launcher states.

- 5411f65: Every owned operation is made for a named owner.
  - Reads, listings and changes of workspaces and runs require `ownerUserId` and serve the resource
    only when it belongs to that owner. A call that names none, or another owner, answers the same
    404 as a missing id. This closes the ID-only operations: `PATCH /v1/runs/:runId`,
    `PATCH /v1/workspaces/:id/name`, and the workspace `attempts` and `events` listings took an id
    and nothing else. `updateRun`, `renameWorkspace`, `listWorkspaceAttempts` and
    `listWorkspaceEvents` gain an optional `ownerUserId` on the wire; the control plane requires it.
  - `POST /v1/runs` creates a run only in a workspace that belongs to the owner it names. A foreign
    key used to be the only check, so any owner could start a run, executed server-side, in another
    owner's workspace.
  - An inference continuation is served only to the owner who opened the exchange; another owner's
    session id answers like one that does not exist. It was addressed by session id alone, on the
    opening owner's credentials.
  - The SDK names the owner on every record read. `workspace.exec()` read the timeline and
    scrollback without one. **An SDK older than this release reading records from a control plane
    with this release gets 404s**: upgrade callers together with the control plane, or set
    `SEALANT_REQUIRE_OWNER_SCOPE=false` on the API for the window between the two.
  - The SSH gateway's shared secret is now verified by the transport gate (its presence used to be
    enough to pass it) and is its own, narrower authority: key and target resolution, plus creating
    and updating the interactive `ssh` runs of the sessions it carries. The gateway sends it on its
    run recorder calls, which a closed control plane used to answer 401, leaving SSH sessions
    unrecorded.
  - The web app makes every control-plane call for the signed-in user, so a workspace or run id from
    another account reads like one that does not exist. Its workspace detail, attempts, events and
    rename routes checked nothing.

### Patch Changes

- f0c7ce9: Registry repository names, tags and digests are held to the OCI grammar and refused
  otherwise, never repaired. `GET /v1/registries/:id/tags` and `/manifest` now answer 400 for a
  `repository` or `reference` outside it (`..`, `%2e`, `?`, `#`, a backslash, a scheme, uppercase,
  an empty segment), and the registry client refuses the same before it builds a URL or a `docker`
  argument, keeps every request on the registry's origin under `/v2/`, does not follow redirects,
  gives each request a 30-second deadline and reads at most 8 MiB of any answer. The local Docker
  image store holds names to the same grammar, and `POST /v1/workspaces` answers 400 for a
  `repository` or `tag` outside it instead of failing the build later. The SDK's generated
  repository slug and the plan coordinates always satisfy the grammar (`.github` becomes `github`,
  `a..b` becomes `a-b`), and a prior publish under a name the grammar refuses counts as nothing to
  reuse. `isOciRepository`, `isOciTag`, `isOciDigest`, `isOciReference` and
  `toOciRepositoryComponent` are exported from `@sealant/api-contracts`.
- 7e6e1fa: Needs sealantd 0.17.0 (sealant-sh/sealantd#86): the capture session channel and every
  presigned object URL are dialled over HTTPS with a verified certificate, and never fall back. A
  plain-HTTP channel is dialled only to loopback, or when the launcher states the network is
  private: `source.transport.plaintext` on the capture source (`SEALANT_CAPTURE_ALLOW_PLAINTEXT` in
  the workspace), which this release already sends. A private CA for the channel or the object store
  rides `source.transport.channelCaPem` / `objectCaPem`. **Behaviour change:** a launcher that
  reaches its channel over plain HTTP on a private network without sending
  `transport: { plaintext: true }` now gets a workspace that refuses to boot, with the reason in its
  log. No new API surface here: `@sealant/runtime-client` and `@sealant/runtime-protocol` move to
  0.17.0, and the baked daemon default for workspace images, the MicroVM image and the Cloudflare
  bridge image is now `ghcr.io/sealant-sh/sealantd:0.17.0`.

## 0.33.1

### Patch Changes

- dcd5f3c: Needs sealantd 0.16.0 (sealant-sh/sealantd#82, #83): a daemon-only release where every
  PUT URL the capture executor mints is bound to the length the PUT then sends — the single-key
  fallback mint declared `0` before, which a registrar that signs an upload for an exact content
  length cannot serve — and where `plan.get` may name `sources`, gzipped archives the daemon lays
  down beside the worktree at boot and at every `capture.replan`, keyed by content and refused if
  they would land inside the worktree. That is how a control plane gets a directory beside the
  repository in a capture-source workspace, which mounts nothing from the host. No new API surface
  here: `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.16.0, and the baked
  daemon default for workspace images, the MicroVM image and the Cloudflare bridge image is now
  `ghcr.io/sealant-sh/sealantd:0.16.0`.

## 0.33.0

### Minor Changes

- c49e0ba: Support the existing Docker service requirement on Lambda MicroVM workspaces when the
  operator configures a separate Docker-capable image and pins the same image ARN/version on API and
  worker. Ordinary workspaces keep their default image. The elevated variant uses guest-root Docker
  inside the MicroVM, with a private Unix socket and disposable graph storage, not a host Docker
  socket or a rootless sidecar.

  The guest validates required-service readiness, prepares runtime directories after snapshot
  restore, and reports Docker failure without losing the terminate hook's capture-flush opportunity.
  Docker images now check daemon startup and cleanup during AWS image validation. This does not
  change the fixed-image runtime model or make MicroVMs execute the workspace-profile OCI image.

  The existing requirement to package the matching `sealantctl` alongside `sealantd` remains. Docker
  activation requires a complete platform image; installing a client package alone is insufficient.

## 0.32.0

### Minor Changes

- da0e848: Add `source.harnessHome` for capture-sourced workspaces. The optional executor-local
  directory is validated, persisted in the workspace blueprint, sent to every runtime as
  `SEALANT_CAPTURE_HARNESS_HOME`, and retained across cold materialization and standby replans. When
  omitted, capture behavior is unchanged.

## 0.31.2

### Patch Changes

- 9b36398: Needs sealantd 0.15.2 (sealant-sh/sealantd#78, #79): a daemon-only patch where the orphan
  reaper no longer reaps the daemon's own children, so `capture.flush` stops failing with
  `No child process (os error 10)` on 4–33% of flushes under load, and a byte-quota refusal is
  terminal instead of retried forever. No new API surface; `@sealant/runtime-client` and
  `@sealant/runtime-protocol` move to 0.15.2 and the baked daemon default for workspace images, the
  MicroVM image and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.15.2`.

## 0.31.1

### Patch Changes

- 8769089: Needs sealantd 0.15.1 (sealant-sh/sealantd#76): a daemon-only patch where tracked files
  win over `.gitignore` and packs and staging survive a long ship. No new API surface;
  `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.1 and the baked daemon
  default for workspace images, the MicroVM image and the Cloudflare bridge image is now
  `ghcr.io/sealant-sh/sealantd:0.15.1`.

## 0.31.0

### Minor Changes

- 28d3d5b: `worktreeId` is optional on the `capture` workspace source. A standby executor launched
  before its worktree exists — to materialise the project base and a dependency cache, then be bound
  to a worktree at claim — omits it; `SEALANT_CAPTURE_WORKTREE_ID` stays unset on every runtime
  (Docker, Kubernetes, Cloudflare) and the daemon takes the worktree from the channel's plan answer.
- c677bc9: A `microvm` runtime adapter id: workspaces can now run on AWS Lambda MicroVMs (one
  Firecracker VM per workspace, driven with the Lambda MicroVMs API and reached through the VM's
  authenticated inbound endpoint). Workspace reads report `runtime.adapter: "microvm"` for such
  workspaces, and blueprints may request `target.runtime.family: "microvm"`. Nothing changes for
  Docker, Kubernetes or Cloudflare deployments; a deployment registers the adapter only when the
  `SEALANT_MICROVM_*` environment is configured.

  `workspace.capture.flush()` (`POST /v1/workspaces/:id/capture/flush`): a final capture, then
  everything staged is shipped and registered on the session channel, answered with the daemon's
  capture status (`pending`, `fenced`, byte and object counts). Synchronous over the control
  connection, refused on workspaces that are not capture-sourced. Needs sealantd 0.14.0 in the
  workspace image, which is now the baked default.

- fbf6c8c: `workspace.capture.replan()` (`POST /v1/workspaces/:id/capture/replan`): the daemon asks
  the session channel for its plan again with no worktree named, delta-materialises the answer over
  what is on disk, and captures under the answered worktree and epoch from then on (the fence lifts,
  foreign queue entries drop). The claim hook for a standby executor. Synchronous over the control
  connection, idempotent (`unchanged: true`), answered with the worktree id, epoch, optional head
  sequence and capture id, and the files and bytes written, skipped and removed. Refused on
  workspaces that are not capture-sourced.

  Needs sealantd 0.15.0, which also makes materialise a delta over what is on disk and sends
  `platform` on `plan.get`; `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.0
  and the baked daemon default for workspace images, the MicroVM image and the Cloudflare bridge
  image is now `ghcr.io/sealant-sh/sealantd:0.15.0`.

### Patch Changes

- b9e68f7: Docker runtime: `SEALANT_DOCKER_WORKSPACE_NETWORK=<name>` attaches every workspace
  container to an existing Docker network (`--network <name>`), so a workspace resolves sibling
  Compose services — a session channel, a bucket — by name without publishing them on the host. With
  the workspace Docker service on, the container joins the shared network beside its sidecar network
  at creation (Docker Engine 25+). Every workspace container also gets
  `--add-host host.docker.internal:host-gateway`.

## 0.30.0

### Minor Changes

- af93419: A `capture` workspace source (sealantd ADR-0015):
  `workspaces.create({ source: { kind: "capture", endpoint, worktreeId, token } })` launches a
  workspace that mounts nothing and clones nothing — the daemon materialises the worktree from the
  session channel onto the executor's own disk and ships captures back, so a session can run where
  no host path exists and outlive any one executor. The create request carries the credential as
  `captureToken`; the control plane seals it beside `secretEnv` and delivers it through the same
  boot file as `SEALANT_CAPTURE_TOKEN`, never into the blueprint or a read response. A capture
  workspace cannot be restarted in place. Runtime support: Docker (no workspace bind), Kubernetes
  (`emptyDir` workspace root, no store claim) and Cloudflare (kept alive while live; planned stops
  now send SIGTERM through `stop()` so the daemon can flush, with `destroy()` reserved for fencing).

### Patch Changes

- 4d64b6a: The worker now keeps workspace images and build scratch bounded. Every build's scratch
  directory (the Containerfile, plan and spec JSON, and the `docker save` tarball on registry
  installs) is removed once the image is published or the build fails; before this each build left
  up to ~800 MB under the worker's temp directory for good. An hourly retention sweep
  (`WORKSPACE_IMAGE_GC_ENABLED`, `WORKSPACE_IMAGE_GC_INTERVAL_MS`, `WORKSPACE_IMAGE_RETAINED_PLANS`,
  `WORKSPACE_IMAGE_MIN_AGE_HOURS`) deletes images no live workspace launched from, no retained plan
  still needs, and nothing published in the last week — on the Engine store by image id, on a
  registry by manifest — and removes build scratch older than six hours, so an upgrade reclaims what
  earlier versions leaked. Stopping a workspace now removes its containers with their anonymous
  volumes; the Docker sidecar used to leave one behind per workspace, and `docker volume prune`
  clears the ones older installs accumulated.

## 0.29.0

### Minor Changes

- f5d4625: Sealant no longer runs RabbitMQ or a zot registry on single-host installs. The job queue
  moved into the control-plane Postgres database (pg-boss, `pgboss` schema; `RABBITMQ_URL` is gone),
  and workspace images now stay in the Docker Engine that builds and runs them: the worker tags the
  built image and launches by image id, with no push, pull, or tarball round-trip. Set
  `REGISTRY_BASE_URL` + `REGISTRY_PUSH_REGISTRY` only to publish to an OCI registry (still required
  on Kubernetes, where the chart keeps its in-cluster registry). `GET /v1/registries/default`
  reports `pushRegistry: "docker-engine"` on installs without a registry. Existing self-host
  installs: re-run the installer (or `docker compose up -d --remove-orphans`) and restart any
  workspace that was mid-build during the upgrade.

  The API's `/docs` page now loads the Scalar viewer from jsDelivr instead of embedding it, and the
  server bundles are emitted as ASCII with comments stripped; together that trims roughly 20 MiB of
  resident memory per Sealant API process and 10 MiB per worker and gateway.

## 0.28.0

### Minor Changes

- d0696d5: Add opt-in Docker named-volume workspace mounts through `SEALANT_DOCKER_VOLUME_MAPPINGS`.
  Containerized applications can share selected worktrees, harness state, control sockets, and
  staged launch files with sibling workspaces without host-directory binds. Existing SDK mount,
  standby, and additional-mount inputs retain their path-based contract; the deployment maps
  canonical paths to existing named volumes and subdirectories. Strict mode validates mappings and
  source directories, requires Docker API 1.45 or newer, and never falls back to host binds. Legacy
  bind mode is unchanged.

## 0.27.0

### Minor Changes

- e889127: Workspace-scoped Docker on Kubernetes, and a create-time refusal where it cannot be
  served. `services.docker` now works on Kubernetes installs whose operator enabled it
  (`workspaces.docker.enabled`): the rootless daemon runs as a sidecar of a user-namespaced
  workspace Pod, the workspace receives `DOCKER_HOST=unix:///run/docker/docker.sock`, and
  `forward({ host: "docker" })` keeps resolving (to the Pod's loopback, where nested containers
  publish). An install that cannot serve the service refuses `workspaces.create` synchronously with
  `WorkspaceDockerServiceUnsupportedError` (HTTP 422, stable `code: "workspace-docker-unsupported"`)
  — the consumer's capability probe, so a workbench can explain the gap beside its Docker switch
  instead of surfacing a launch failure minutes later.

## 0.26.0

### Minor Changes

- 643f809: Standby workspaces and bindable mounts (sealantd ADR-0014, Mend ADR-0001). A workspace
  can now be created with `source: { kind: "standby", rootPath }`: the caller-owned root (a
  project's worktrees directory) is mounted hidden and the working directory does not exist until
  `workspace.bind({ subpath })` points it at one of the root's subdirectories — after the container
  is already running, which neither Docker nor Kubernetes allow for a mount. An extra mount declared
  `bindable: true` works the same way for its own path, so a project can mount a sibling
  repository's worktrees and bind one at `/workspace/repos/<name>`. `POST /v1/workspaces/:id/bind`
  applies the bind over the daemon's control connection and records the workspace's live bindings,
  which every relaunch re-supplies. Requires a sealantd with `bindMount` (runtime-client 0.13).

## 0.25.0

## 0.24.1

## 0.24.0

### Minor Changes

- dd88081: Accept `"cloudflare"` as a workspace runtime adapter id in the core API contracts. The id
  names the Cloudflare Sandbox runtime family; deployments that do not register that adapter keep
  answering such requests with the existing `unsupported-runtime` error.
- 2ca12be: Cluster env sources at the create boundary (cluster-env-sources design, phase 1 of 2).
  - `workspaces.create` accepts `envFrom` — an ordered list of
    `{ kind: "secret" | "configmap", name }` naming Kubernetes objects in the platform's workspaces
    namespace whose keys become workspace environment, resolved by the platform worker at creation —
    and `kubernetes.serviceAccountName`, an explicit allowlisted trust grant for the workspace Pod.
  - On a deployment whose effective runtime family is not Kubernetes, create refuses synchronously
    with the new typed error (`WorkspaceRuntimeEnvReferencesUnsupportedError`, HTTP 422, stable code
    `runtime-env-references-unsupported`). The stable code doubles as the SDK consumer's capability
    probe.
  - This release carries the surface and the fail-closed gate only; worker-side resolution (label
    opt-in, both kinds, ordering semantics, the ServiceAccount allowlist) ships in the companion
    change — until it lands, Kubernetes launches with these fields are refused with an honest "not
    resolved by this platform build yet".

## 0.23.0

## 0.22.0

### Minor Changes

- b45e4a4: Per-user identity for products that own their own login.
  - **Service principals.** `SEALANT_SERVICE_KEYS` (API) closes the control plane: every `/v1`
    request must carry a service key as a bearer (may assert any `ownerUserId`) or, on the session
    surface, a scoped user access token. Unset keeps the open loopback-only model. Public routes
    (`/healthz`, `/readyz`, `/openapi.json`, `/docs`) and the gateway routes are unaffected.
  - **Users endpoint.** `POST /v1/users` upserts a user by email and `GET /v1/users/:userId` reads
    one — the provisioning path for a product that maps each of its users to a Sealant user.
  - **Owner scoping on reads.** `GET /v1/workspaces/:id` and the `GET /v1/runs/:id` family accept an
    optional `ownerUserId` query and answer 404 when it does not match; the SDK always sends it,
    closing the by-id reads that previously leaked across owners.
  - **SDK.** `SealantConfig.ownerUserId` (one client per user; overrides `SEALANT_OWNER_USER_ID`),
    `sealant.users.{ensure,get}`, and `sealant.connectedAccounts.{list,connect,disconnect}`; the
    matching `/effect` operations and contract errors are exported.

## 0.21.0

### Minor Changes

- 06295a9: Pipe-mode sessions: `workspace.sessions.open(argv, { mode: "pipe" })` (and
  `POST /v1/sessions` with `mode: "pipe"`) starts the leader with plain stdio pipes and no
  controlling terminal — the shape for processes that speak a byte protocol over stdin/stdout, such
  as `codex app-server` or `claude --print --input-format stream-json`. `send` feeds stdin,
  `output`/`attach` carry stdout byte-exact with the same replay-from-sequence semantics as PTY
  sessions, stderr is recorded as diagnostics only, and `resize` is rejected. Sessions report
  `mode`; the default stays `pty`. Requires sealantd ≥ 0.11 in the workspace image.

## 0.20.2

### Patch Changes

- fb27d3f: Workspace images install claude-code with `--allow-scripts=@anthropic-ai/claude-code`:
  recent npm blocks install scripts by default, and claude-code's postinstall is what links its
  native binary — without it every `claude` launch died with "claude native binary not installed"
  once the v0.20.0 plan-hash rotation rebuilt images. Codex was unaffected (no install script).
  Older npm treats the unknown config as a warning; plan hashes rotate once so broken images
  rebuild. No API surface changes; this release exists to rebuild workspace images.

## 0.20.1

### Patch Changes

- 4effb57: The api image bakes system CA certificates. The Codex CLI the codex inference engine
  spawns is a native binary that validates TLS against `/etc/ssl/certs`, which
  `node:24-bookworm-slim` does not ship — every codex exchange failed with "invalid peer
  certificate: UnknownIssuer" until the store exists. Node's own TLS (and therefore the claude
  engine, which runs through the Agent SDK) was never affected. No API surface changes; this release
  exists to rebuild the image.

## 0.20.0

### Minor Changes

- 7e8d789: Codex inference on connected accounts: `/v1/inference/respond` (and
  `sealant.inference.respond`) now accepts `credentials: { codex: true | "<name>" }` and runs the
  exchange through the official Codex CLI against a private per-invocation `CODEX_HOME`, on the
  caller's own OpenAI subscription. `model` passes through verbatim on both arms. The rotated
  auth.json is read back at end of exchange and persisted newest-wins, exactly like the workspace
  sync-back. Tool-less v1: caller-defined `tools` stay claude-only (a codex exchange with tools is a
  400), `maxTurns` is claude-only, and a profile-only selection prefers the profile's claude binding
  before falling back to its codex binding. Selecting both providers in one exchange is now an
  explicit 400.

## 0.19.1

### Patch Changes

- efd0fe7: Workspace images bake `bubblewrap` alongside the Codex CLI. Codex's Linux sandbox wants a
  system `bwrap` and printed "Codex could not find bubblewrap on PATH … will use the bundled
  bubblewrap" on every launch without it — the first thing every new workspace showed. The
  prerequisite now travels with the harness integration on every family (fedora, arch, ubuntu, nix),
  so the banner is gone and Codex sandboxes with the distro's `bwrap`. Image plan hashes change, so
  existing workspace images rebuild once.

## 0.19.0

### Minor Changes

- a761e8c: Secret environment variables on `workspaces.create({ secretEnv })` — the transient secret
  channel.

  The map is validated by the exported `parseWorkspaceSecretEnv` (same grammar/bounds as `env`, same
  platform-owned reservations, but secret-shaped names allowed; connected-account names stay
  reserved), rides the create request beside the spec, is sealed with the install's credential key
  on the build job, decrypted by the worker just before launch, staged as a `0600` boot file the
  workspace daemon (sealantd ≥ 0.10.0) reads once, removed from the host the moment the workspace is
  ready, and cleared from the job row when the launch settles. It never enters the blueprint, the
  attempt snapshot, `docker run` argv, container env, or any read API; every value is masked in
  captured process output; every process the platform starts in the workspace inherits it, winning
  over `env` and container env for the same name. Platform-side restarts run without secret env by
  design. The workspace image now bakes sealantd 0.10.0.

- e621c78: Non-secret workspace environment variables on `workspaces.create({ env })`.

  The map is validated against a public policy (grammar, size bounds, reserved platform names, and
  secret-looking names the workspace runtime would silently drop), lowered into a new strict
  `runtime.userEnv` blueprint field, set on the workspace container, and inherited by every process
  the platform starts inside the workspace — the harness, later shells, and exec'd commands. Values
  are ordinary configuration by contract: they persist verbatim in the durable workspace spec and
  are returned by workspace-details APIs; secrets stay on `credentials`. Live workspaces are never
  mutated, restarts reuse the stored spec, and caller values can never override platform controls or
  injected credentials (caller env is emitted first under docker's last-wins `-e` ordering).

  The policy is exported from both packages (`parseWorkspaceEnv`, `findWorkspaceEnvReservedRule`,
  `formatWorkspaceEnvIssue`, `WORKSPACE_ENV_*` constants; also importable via
  `@sealant/api-contracts/workspace-environment`) so downstream settings surfaces validate with the
  platform's exact rules. Legacy `runtime.env` keeps its unrestricted stored-spec semantics and is
  not emitted by the SDK; worker-resolved dotfiles clone auth moved off that field onto a transient
  adapter launch input and no longer rides any blueprint env map.

## 0.18.1

### Patch Changes

- 98521fc: Dotfiles archives now stage under the control-socket shared directory when the worker
  runs inside the self-host compose stack. `docker run -v` resolves bind paths on the daemon's host
  filesystem, so archives staged in the worker container's private tmpdir arrived as an empty mount
  and boot aborted with "manifest.json: No such file or directory". The staging root now follows
  `WORKSPACE_CONTROL_SOCKET_HOST_DIR` (`<dir>/_dotfiles/…`) — the one path the stack bind-mounts at
  the same location on both sides — and host-run workers keep using the system tmpdir.

## 0.18.0

### Minor Changes

- 0d4d02b: Dotfiles and shell:
  `workspaces.create({ shell: "zsh", dotfiles: { repository, archives } })`. `shell` installs the
  login shell and switches to it so shell dotfiles take effect. `dotfiles` accepts a repository the
  platform clones (manager auto-detected: chezmoi / stow / copy, optional bootstrap) and/or
  caller-resolved archives — gzipped tars applied at boot through the same manager dispatch, the
  shape for dotfiles resolved host-side with the caller's own ssh identity or scanned from the home
  directory. The repository applies first, then archives in order; everything applies before the
  workspace reports ready, and a failing apply fails the launch loudly. Dotfiles ref handling no
  longer assumes `main` (absent = the remote's default branch), chezmoi is provisioned on every
  managed family (on Ubuntu 24.04 from the pinned upstream release — the archive has no package),
  and client-supplied `authRef`s are now validated at create against the caller's GitHub
  installation grants. Not supported with `baseImage`.

## 0.17.0

### Minor Changes

- ae55cdd: Custom base images: `workspaces.create({ baseImage: "node:22-bookworm" })` builds the
  workspace image from any caller-supplied OCI reference instead of a managed OS family. Distro
  package installs are skipped; the build overlays only the sealantd supervisor, the harness CLIs
  (npm), and a fully static socat relay (vendored beside sealantd). The base-image contract
  (documented in the SDK README): any Linux base on amd64/arm64 with a POSIX shell, node + npm for
  the harness CLIs, git for clone/mount sources — each checked at build time with readable failures,
  including a shell-less base. `packages` pass through verbatim to the base's own detected package
  manager (apt/apk/dnf/pacman). `baseImage` and `os` are mutually exclusive.
- cd4ce97: Ubuntu as a first-class workspace OS family: `workspaces.create({ os: "ubuntu" })` builds
  the workspace image from `ubuntu:24.04` with apt-installed packages (cached, non-interactive), the
  same baked harness CLIs, socat relay, and `sealantd boot` entrypoint as the other families.
  Package standardization resolves portable package names against the Ubuntu 24.04 archive (`python`
  → `python3`, `fd` → `fd-find`, `github-cli` → `gh`); packages the archive does not carry (`pnpm`,
  `uv`, `mise`, `lazygit`) are reported unsupported at create time. The `resolvePackage` response's
  `osSupport` now always carries an `ubuntu` entry, so an SDK at this version needs a control plane
  at the same version.

## 0.16.0

### Minor Changes

- 9472211: UDP forwards: `workspace.forward(port, { protocol: "udp" })` opens a connected-UDP
  forward in the workspace instead of a TCP stream — one frame on the pipe is exactly one datagram,
  both directions (`?protocol=udp` on the forward WS route; sealantd 0.7.0 underneath). TCP is
  unchanged and remains the default.

## 0.15.0

### Minor Changes

- cfb6965: `workspace.forward(port, { host })`: the forward target grows from fixed loopback to a
  closed workspace-private set — `127.0.0.1` (default) or `docker`, the workspace-scoped Docker
  sidecar's network alias. Inner `docker compose` publishes its ports on that sidecar, so a database
  started by compose is now reachable through the same forward surface. Never caller-arbitrary: the
  allowlist is the SSRF boundary.

## 0.14.0

### Minor Changes

- 4a735c8: `workspace.forward(port)`: a raw TCP byte pipe to `127.0.0.1:port` inside the workspace,
  over one held WebSocket (`GET /v1/workspaces/:id/forward?port=N`, scope `workspace:exec`). The
  public surface for sealantd's existing forward primitive — protocol-agnostic, never recorded, host
  fixed at loopback. Nothing listening on the port is an HTTP 502 before the upgrade; a text
  `{"t":"eof"}` frame carries TCP half-close, which WebSockets lack natively.

## 0.13.5

### Patch Changes

- efcee92: Bake every supported harness CLI into each workspace image (codex + claude-code; opencode
  installs as an extra when a blueprint requests it), and inject `SEALANT_HARNESS_BANNER` /
  `SEALANT_HARNESS_LAUNCH_COMMAND` at container launch instead of baking them as image ENV. Harness
  choice now decides what launches, not what is installed — a shell in any workspace can open either
  baked agent against the same files and state.

## 0.13.4

### Patch Changes

- 6b91552: Allow the self-host API to open persisted workspace control sockets by mounting the
  socket directory read-only and using sealantd's required root peer identity, while dropping all
  Linux capabilities and forbidding privilege escalation.

## 0.13.3

### Patch Changes

- 145295d: Include the Docker Compose CLI plugin in workspace images whenever the workspace-scoped
  Docker service is enabled, so `docker compose` works against the workspace's disposable daemon.

## 0.13.2

### Patch Changes

- c245231: Keep API-backed workspace sessions on the persisted Unix control socket, including
  workspaces that do not enable SSH, so self-hosted API containers can supervise runs without a
  Docker CLI.

## 0.13.1

### Patch Changes

- bb4ae55: Declare Effect as a consumer-provided peer dependency so `@sealant/sdk/effect` and
  `@sealant/api-contracts` compose with the consumer's compatible Effect runtime instead of
  installing an incompatible second copy.

## 0.13.0

## 0.12.3

### Patch Changes

- bf5a55b: Forward the workspace mount allowlist and connected-account encryption key from self-host
  `.env` configuration into the API and worker containers.

## 0.12.2

### Patch Changes

- f605a8b: Workspace images now bake sealantd 0.6.2, so an interactive harness returns the terminal
  as soon as its session leader exits instead of waiting for helper processes that inherited the
  PTY. The platform release also admits the matching 0.6.2 runtime SDK packages through the
  minimum-age gate.

## 0.12.1

### Patch Changes

- 7ca347a: The sealant-worker image now carries the Claude Agent SDK's vendored `claude` platform
  binary, so the session keep-fresh sweeper's refresh ping actually runs in production (v0.11.0
  shipped without it; the sweeper's own logging caught the gap — "Native CLI binary for linux-x64
  not found" — and degraded safely to skipped-not-newer). The staging script is shared with the api
  image, and both runtime images now assert at build time, per arch, that the binary resolves
  exactly the way the bundle resolves it at runtime — a broken layout fails the image build, never
  the first sweep/inference in production.

## 0.12.0

## 0.11.0

### Minor Changes

- 8d86e05: Claude session credentials (`kind: "credentials-json"`) stay fresh instead of expiring
  whenever no workspace happens to run. Refresh was coupled solely to run-exec jobs; now the
  official Claude Code CLI/Agent SDK refreshes the session on three paths and the control plane
  persists the rotated file newest-wins on `claudeAiOauth.expiresAt`: inference runs the CLI against
  a private per-invocation `CLAUDE_CONFIG_DIR` holding the decrypted session file (refresh at point
  of use; setup-token accounts keep the env-var path), a worker sweeper refreshes any active session
  account expiring within 30 minutes every 15 minutes via a minimal one-turn exchange, and the
  workspace sync-back now also runs on every container teardown path (stop, expiry reap) so
  interactive sessions no longer lose rotated tokens. Every considered account logs exactly one sync
  outcome line. The compliance rule is unchanged: Sealant never calls Anthropic's token endpoint.

## 0.10.0

### Minor Changes

- cc7dddc: Claude connected accounts accept a second credential shape: the full Claude Code session
  credentials file (the JSON contents of `~/.claude/.credentials.json`) pasted by the operator.
  Session-file accounts (`kind: "credentials-json"`) are injected into workspaces as a
  `$HOME/.claude/.credentials.json` file with mode 600 — mirroring codex's auth.json — instead of
  the `CLAUDE_CODE_OAUTH_TOKEN` env var, present as the user's subscription (Anthropic treats setup
  tokens as API auth, which credit-gates some models interactively), and are synced back after runs
  newest-wins on `claudeAiOauth.expiresAt`. Existing `sk-ant-oat01-…` setup-token accounts keep
  working unchanged; reconnecting can switch shapes in place.

## 0.9.0

## 0.8.1

## 0.8.0

### Patch Changes

- 091ef5c: A real data plane for interactive terminals: `session.attach()` over one held WebSocket.

  The request/response session verbs made every keystroke pay auth + DB lookups + a fresh
  short-lived daemon connection (a `docker exec` spawn per event on the default transport), and
  output rode a 250ms journal poll — hopeless for an interactive terminal. New raw route
  `GET /v1/sessions/:sessionId/attach` upgrades to a WebSocket, authenticates once, opens ONE daemon
  control connection for the socket's lifetime, and bridges the daemon's reliable attach channel
  (byte-exact replay from `?from=`, then live output) both ways. Binary frames are PTY bytes; text
  frames are control JSON (`{"t":"resize",...}` up, `{"t":"end"}` down). The SDK exposes it as
  `session.attach({from})` → `SessionAttachment` (`send`/`resize`/`output`/`closed`/`close`). The
  existing `send`/`output` verbs remain the request/response control plane.

## 0.7.1

### Patch Changes

- e0aab44: Strip the create-payload `credentials` key from the workspace spec before it reaches the
  build job. The SDK folds `credentials` into the spec it sends; the api lowers it into
  `runtime.credentialRefs` but previously left the raw key in place, and the worker's strict
  blueprint schema rejected it — killing every `mount` + `credentials` create at
  `parseWorkspaceBlueprint` ("Unrecognized key: credentials"). Mount-sourced workspaces with
  connected-account credentials now build.

## 0.7.0

### Minor Changes

- 649d965: Mount-sourced workspaces, first-class interactive PTY sessions, scoped access tokens, and
  byte-exact resumable session output — the Mend agent-workbench P0 surfaces (plan §8.1.A/§8.1.B).
  - **Mount source**: `workspaces.create({ source: { kind: "mount", path } })` provisions the
    workspace from a caller-owned host directory bind-mounted as the working directory instead of a
    clone (sealantd ≥ 0.6.0). The path is caller-owned: writes persist across stop/restart/expiry
    and the platform never reprovisions or deletes it. Paths must be proper descendants of an
    operator-configured allowlist root (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`, enforced at the API,
    the launch adapter, and daemon boot). Credentials and dotfiles options compose unchanged;
    clone-based workspaces are unaffected.
  - **Interactive sessions**: `workspace.sessions.open(argv)` / `.get(id)` / `.list()` and a real
    `harness.session()`. Sessions are durable platform resources: the PTY survives handle and
    process loss, and a session re-fetched by id from any workspace handle supports `send()` (string
    or bytes), `resize()`, `signal()`, `status()` (with the output high-water cursor), and
    `close()`. New control-plane endpoints under `/v1/sessions`, including an SSE live tail
    (`/v1/sessions/:id/output/stream`).
  - **Byte-exact resumable output**: session output is recorded redacted and sequence-keyed;
    `session.output({ from })` replays exact history and continues into the live tail, resumable
    after any disconnect via `lastChunk.sequence + 1n`. `GET /v1/runs/:id/scrollback` gains
    `fromSequence`/`limit` range reads and a `pty` stream for interactive runs.
  - **Scoped access tokens**: `sealant.accessTokens.create({ scopes, workspaceId?, ttl? })` mints
    bearer tokens over three scopes — `session:read` (stream/status), `session:input`
    (input/resize/signal), `workspace:exec` (open terminals) — enforced on the session surface, so a
    read-stream token can stream but is rejected for input and exec.
  - **Server-side run commands**: run invocations for built-in harnesses are constructed by the
    control plane (persisted on the run), so `workspaces.get(id)` handles can start harness runs; an
    explicit client command remains the `customHarness()` escape hatch.
  - **Correlation metadata**: opaque `metadata` bags accepted at run and session creation, stored
    verbatim and echoed on reads.
  - sealantd image pin bumped to 0.6.0 (mount boot contract, durable PTY session journal, file
    events on by default).

## 0.6.0

### Minor Changes

- 6d1d72d: Workspace lifecycle close-out: `workspace.stop()`, `workspace.restart()`, and
  `workspace.expire()` are real end-to-end operations instead of `SealantNotImplementedError`
  rejections.

  - New control-plane endpoints: `POST /v1/workspaces/:id/stop` (async 202 — the worker removes the
    container and records the terminal `stopped` state), `POST /v1/workspaces/:id/restart` (async
    202 — a fresh launch from the same resolved spec, recorded as a new attempt), and
    `POST /v1/workspaces/:id/expire` (sets, clears, or triggers the workspace TTL).
  - `WorkspaceStatus` gains `"stopped"`, and workspace summaries/details expose `expiresAt`.
  - `createWorkspace` accepts an optional `ttlSeconds`; the SDK's `create()` accepts
    `ttl: "2h"`-style durations. Expired workspaces are stopped by the platform reaper.
  - SDK `stop()` blocks until the workspace reports `stopped`; `restart()` returns a fresh handle
    whose `ready()` gates on the new runtime; `expire({ in: "2h" | null })` sets or clears the TTL.

  Compatibility: adding `"stopped"` to the workspace status enum changes the wire contract — older
  published SDKs decode workspace responses against the previous five-value literal union and will
  fail to decode a stopped workspace. Upgrade the SDK together with the control plane.

## 0.5.0

### Minor Changes

- 0d2ce1c: Inference on connected accounts. New `inference` contract group:
  `POST /v1/inference/respond` runs short, tool-calling inference loops on the caller's own
  subscription — the server resolves the connected-account reference (same shape as workspace
  creation), decrypts, and invokes the OFFICIAL Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN`
  (never raw model-API calls on stored credentials, per the connected-accounts design's hard
  constraint). Caller-defined JSON-schema tools are exposed to the model verbatim; tool calls park
  server-side and the CALLER executes them, posting results back in a multi-turn session loop.
  Structured output rides the agent SDK's native json_schema output format. SDK:
  `sealant.inference.respond(...)` (new exchange or continuation) + `inferenceRespondOp` in the
  Effect core. Usage is attributed per account (`last_used_at`), and a live auth rejection marks the
  account invalid. Claude accounts only; Codex inference is a stated follow-up.
- 5cabebb: Typed record-event taxonomy. `@sealant/api-contracts` now exposes the payload schemas
  behind every recorded event kind (process, io, file, network, runtime, and loss events — the
  stored jsonb shape: uint64s as decimal strings, protocol enums as numbers) plus
  `decodeRecordEventPayload`, a total decoder that folds a wire `(kind, ref)` pair into a
  discriminated union and degrades to an `unknown` case instead of throwing. The SDK's
  `TimelineEntry` is now that discriminated union: switch on `kind` and `data` narrows to the typed
  payload, with `{ kind: "unknown", rawKind, data }` as the forward-compatibility case for kinds
  newer than the SDK. No new event kinds were added; a file-read/open event is noted as future work.
- 436546e: Deterministic exec in a workspace. New contract endpoint `POST /v1/workspaces/:id/exec`
  executes an ORDERED LIST of commands in the workspace, recorded as ONE run (a "check run") on the
  same run-exec pipeline as harness runs — every command executes in order regardless of exit codes
  (a nonzero exit is a check datum, e.g. `base fails · head passes · revert fails`), and the run
  completes iff every command executed and was recorded. SDK: `workspace.exec(argv, { cwd? })`
  returns `{ exitCode, stdout, stderr, run }`, resolving on nonzero exits and rejecting only when
  the execution machinery itself broke.

## 0.4.0

### Minor Changes

- a551b17: Rename the product's core noun from `sandbox` to `workspace` across the public API and
  SDK. "Workspace" is the honest, industry-standard name for the live, disposable environment a
  harness works in — Sealant does not provide a hardened security sandbox, so the old name
  over-promised containment. The `run` and `harness` nouns are unchanged.

  Concretely, this changes web and API routes from `/sandboxes` to `/workspaces`, renames the SDK
  surface (`sealant.sandboxes` → `sealant.workspaces`, and the `sandbox` handle to `workspace`),
  switches the SSH username prefix from `sbx-` to `ws-`, adds a rename-only database migration for
  the workspace tables and columns, and renames the internal `@sealant/sandboxes` package to
  `@sealant/workspaces`.

## 0.3.1

## 0.3.0

### Minor Changes

- bf3dc5e: `updateRun` accepts optional `diff` and `changedFiles` on terminal status transitions, so
  callers that observed a run's file changes (e.g. the SSH gateway finalizing an interactive
  session) can persist them alongside the status flip.

## 0.2.0

### Minor Changes

- 6234d20: First public release of the fluent SDK.
  - `harness.run(prompt)` — blocking one-shot execution: registers the run server-side, resolves
    once terminal with the captured changes (files + diff) inline.
  - `harness.start(prompt)` — non-blocking: same server-side run, returns the live `Run` handle
    immediately; stream progress with `run.record.stream()` and settle with `run.wait()`.
  - `run.wait()` now fetches the server-side captured changes once the run is terminal, so handles
    from `start()` and `runs.get()` settle with an honest diff.
  - Execution-record read surface: `replay()`, `timeline()`, `stream()`, `scrollback()`,
    `commands()`, `transcript()`, `loss()`, `summary()`.
  - `@sealant/api-contracts` ships as the contract-first HTTP API definition the SDK's client is
    derived from.
