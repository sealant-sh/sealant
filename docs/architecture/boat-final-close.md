# Boat stop: FINAL, then DELETE, on the shared stop path

A Boat session is stopped by the same path that stops every runtime's executor
(`worker/process-workspace-stop.ts`), recovered by the same sweep
(`worker/recover-retained-executors.ts`) and watched by the same exit reconciler
(`worker/reconcile-runtime-exits.ts`). Boat has no close owner of its own. What stays Boat's is the
adapter (`runtime/boat/adapter.ts`), the one deletion of a VM and the release of what it held once
Boat no longer has it (`runtime/boat/removal.ts`), and a small convergence sweep
(`runtime/boat/convergence.ts`). Every fact Core holds about a Boat run is a column of its one row
in `boat_runs`, each written by one guarded statement (`packages/db/src/repositories/boat-runs.ts`).

A stop is the FINAL drain, then the VM's deletion, then a poll of Boat's deletion operation. A VM
whose FINAL is incomplete stays until FINAL completes or the owner discards it, without bound.
Resuming is a fresh VM from the project snapshot plus the captured worktree.

The rule that outranks everything: no loss of work. A session's worktree is captured before its VM
is deleted, on every path. Nothing a VM held is released before Boat's own word that it no longer
has the VM. That word is a typed 404 for a VM Boat had reported past creation, or its completed
deletion operation; never elapsed time, an error or a failed read.

## A stop, step by step

1. **Claim.** The stop takes the run's capture drain claim. A second stop of the same run (the
   expiry reaper's, the sweep's nudge) finds it held and leaves the run alone (`busy`).
2. **Stop request.** The adapter declares `stopRequestBeforeDrain`, so the stop reason is written to
   the runtime row now, before anything is asked of the VM. Boat's launch and link paths read it as
   their fence (`BoatRunRepo.isActive`, `boatTargetIsCurrent`): from here on no launch is pushed and
   no resource link is configured for the run.
3. **Inspect.** The adapter says whether the VM is `running`, `exited` (its daemon is not known to
   be up) or `missing` (below).
4. **Drain.** A running executor is sent FINAL through the worker's drain control
   (`BoatControlMaterial.drainMaterial`) and polled until it reports the flush complete. Empty
   queues do not count. Incomplete, unreadable, contradictory or unrecorded evidence keeps the VM:
   the stop answers `kept`, and every later pass flushes again.
5. **Authorize.** The preservation policy (`decideExecutorDeletion`) decides on the capture record
   as it stands, and a removal that rests on evidence takes a deletion ticket from the capture
   ledger, re-checked and issued right before the runtime call.
6. **Remove.** `BoatRuntimeAdapter.stop()` deletes the VM (below) and returns once Boat no longer
   has it. A deletion Boat accepted and has not finished is `removalPending`: the stop answers
   `draining`, nothing is released, and the next pass polls the operation.
7. **Record.** The runtime row is recorded stopped and removed, the ledger's removal completed, the
   drain's outcome written.

A stop whose executor ended (`exited`) with nothing on record that its work was saved is kept and
recorded retained, which starts the recovery sweep at once.

## Removal without the guest

Three things let a stop remove a VM without the guest answering:

- **Absence.** Boat itself says the VM is gone. The stop only cleans up; no DELETE is sent.
- **Discard.** The owner discarded the unsaved captures (`requestDiscard`). The VM is removed under
  the `discarded` basis and the capture ends `discarded`.
- **Attestation, for an executor that ended.** A trusted caller attested a sealed FINAL of this
  executor (`attestCompletion`) that covers everything Core observed of it, and its daemon has
  ended. The VM is removed under `attested-complete`. A VM whose daemon is still up is drained first
  whatever is attested, as on every runtime: it may have written since the seal.

An identical attestation submitted again is not new evidence and leaves the evidence version
unchanged. A removal already authorized and issued is never stranded by newer evidence that
authorizes the same removal: it is re-based on the current evidence and issued again.

### Trust boundary: attestations are believed

Core cannot verify an attestation against the capture store; it records what an authorized service
caller asserts. A false attestation that nothing Core observed contradicts is believed, and the VM
with any unsaved work is removed. Core refuses an attestation only when it names another executor or
when a later observation of the daemon (a higher epoch, a later unsaved capture) contradicts it.
Granting the attestation route to a caller is therefore granting it authority to end that executor's
retention.

## Recovery of a kept VM

The recovery sweep asks the adapter to `recover` a retained VM. The adapter fences first, so nothing
can start on the VM again whatever it answers:

- **No launch was ever pushed** (the VM was never bound, or its execution had not reached the push):
  the execution is aborted, a compare-and-set against the push, and the answer is `nothing-to-save`,
  from Core's own record that no daemon ran. The sweep then removes the VM.
- **A launch may have been pushed:** the execution is held and the
  [guest agent](boat-guest-agent.md) is asked to recover the capture (`POST /sealant/recover`, with
  the capture token the sweep unsealed from the run's capture record). The agent answers from its
  durable records: `running` (the daemon is up), `restarted` (sealantd had exited and was started
  again in recovery mode on the VM's own disk), or `nothing-to-save` (the recovery boot exited 76
  because it never materialized a capture, or this boot was bound and never launched). On `running`
  and `restarted` the sweep drains FINAL and removes the VM once that is confirmed. The agent's
  `no-launch` answer is taken only once the launch that issued the push is over.

The agent's refusals (`recover-new-boot`, `recover-binding-conflict`, `recover-state-unknown`), its
503 when it cannot prove the workspace's processes stopped, a daemon without sealantd's recovery
boot and a recovery with no capture token are all `unsupported`: the VM is kept until its owner
discards it. A malformed answer or lost transport is a failed attempt, retried on the backoff.

## One removal

`BoatRemoval.remove(run, { authorized })` is the one deletion of a Boat VM. It decides nothing about
the work on the VM. In order:

1. Observe the VM (`BoatVm.observe`). If Boat no longer has it, release what it held and stop.
2. If a deletion operation is on record, poll it. DELETE is never sent again.
3. Otherwise DELETE goes only to the exact owned VM Boat just returned, for a run that is stopping
   or failed. A VM a daemon may have run on (its launch may have been pushed) is deleted only when
   the caller's `authorized` answers yes. A VM no launch was ever pushed to is the removal's own to
   delete.
4. Fence (`fenced_at`), by one statement that competes with the launch push on the row: a launch
   that was pushed is held with its bearer kept, and one that never was is never pushed. The run's
   tunnel is frozen if it has one. A configuration holding the gateway host lock is waited for, 15 s
   at most; past that nothing is sent and the removal fails as a refusal.
5. Claim the first DELETE (`deletion_claimed_at`, by the database's clock). Of two calls with
   nothing on record one sends the DELETE; the other waits for what it records. A claim whose caller
   vanished keeps every other call off for 180 s.
6. Send DELETE, record Boat's operation (`deletion_operation_id`) before any wait, and wait at most
   20 s for `completed`, reading the VM itself on every poll: Boat's typed 404 for a VM it had
   reported past creation ends the wait too.
7. `completed` is recorded with the VM's absence in one statement (`deletion_completed_at`,
   `absent_at`, `absent_basis: deletion-completed`), which also erases the sealed launch material.
   Then what the VM held is released: the gateway removed and the tunnel slot released if the run
   has one, then the publication pin. While Boat still says the deletion is in progress it answers
   `deleting` and releases nothing.

`BoatRemoval.cleanup(run)` is the release alone, against a committed absence: it asks Boat nothing
and never sends DELETE.

The claim and the operation are written only for a run that is stopping or failed and whose VM
nothing can start on again: never bound (the claim fences it), or fenced. A lost DELETE reply leaves
the claim, given up so the next pass asks again after reading the VM. Another operation id for the
VM refuses. Once completion is recorded, an older pending answer cannot downgrade it, and the first
absence stands whoever reads the VM afterwards.

A run closed by a version that kept the operation on its tunnel reservation was carried by the
`boat_runs` migration with that operation on its row: it is polled like any other, and no second
DELETE is sent for it.

### What authorizes `stop()`

`BoatRuntimeAdapter.stop()` finds the VM by `(deployment_id, sandbox_id)` and calls `remove`. Its
`authorized` reads, at the moment a DELETE is about to be sent:

- the run's capture record holds an issued removal under a live hold (the shared path's deletion
  ticket, issued right before the call and only while its evidence is still current); or
- the owner's discard is on that record; or
- this adapter's own `recover` answered, in this process and within ten minutes, that the VM holds
  nothing to save.

Every caller of `stop()` in the shared paths holds one of those, or acts on an executor reported
`missing`, which only cleans up. Anything else is refused before Boat is asked (`close-held`, marked
`removalRefused`). A deletion in progress is `close-pending` marked `removalPending`; a failure once
Boat was asked and before its operation was recorded is `close-pending` unmarked, an outcome nobody
knows. The whole call is bounded (45 s). It declares no `removalFenceMs`, since Boat states no bound
on a deletion.

### Second observers of a deletion

The removal is not the only observer of its own deletion. Boat answers 404 for the VM soon after a
DELETE, often while the operation still reads `processing`, and whatever reads the VM then commits
that absence. Four callers can overlap one stop:

- **The exit reconciler** polls every ready run, stop requested or not. Its `inspect` commits the
  404 and answers `missing`. With the stop's removal issued and held, the reconciler's probe is
  refused by the capture ledger and it writes nothing. Once the stop has recorded the run stopped
  and until it has recorded the removal complete, the run is also an ended executor nothing settled,
  which the reconciler looks at: it reads the removal as issued, and when it settles it finds it
  held by the stop, or recorded complete by it meanwhile (`already-deleted`). Either way it settles
  nothing and says nothing.
- **Boat's convergence sweep** releases what a VM recorded absent still holds, on every tick. If it
  gets there first, the removal finds the row already absent and ends there. The two releases meet
  on the run's gateway host lock: one removes the gateway and releases the slot, and the other finds
  the lock held and leaves it (`busy`), saying nothing. `stop()` still returns at once, because Boat
  no longer has the VM. A slot one caller released is read again by the other, at its read or at its
  write, and found released; the pin is released under the publication's row lock, where the second
  caller finds it released. A real failure (the gateway host unavailable, a slot on another host) is
  still warned of by the caller that met it.
- **A second stop** (the expiry reaper's, the sweep's nudge) finds the drain claim held: `busy`.
- **The recovery sweep** acts only on a retained run, under its own claim, and a removal issued by
  another path keeps it off.

So once its DELETE is out, the removal takes a committed absence for the deletion's end wherever it
meets one (a row already absent, an operation it can no longer record or poll, a wait that ran out)
and releases in the same call. Only the committed absence counts: a failed read, a timeout and a 404
for a VM Boat was never seen to report past creation are not absence, nothing is released before a
committed absence, and no second DELETE is sent.

## What the runtime adapter reports (`inspect`)

Found by sandbox id:

- `missing`: only from a committed absence: Boat's typed 404 for a VM that was seen past creation,
  or a completed deletion operation.
- `exited` with `platformEnded: false`: the agent's health names `daemonExit`; or the run is
  stopping or failed and no daemon is known to be up on its VM (no launch was pushed, a push was
  never confirmed, or the agent reports no launch on its boot for a run that was never ready).
- `running`: everything else, including every failed, timed-out or unreadable read of Boat or the
  agent, a launch still in flight, and an agent that reports no launch on its boot for a run that
  was ready (it restarted and could not adopt its record; the daemon may be alive).

Boat and the agent are read at most once per VM per 60 s, or per 15 s once the run is stopping or
failed, and `running` is answered in between. Only `running` is ever answered without a read: an
`exited` or `missing` is never served from memory. The daemon's last output is redacted with the
run's bearer only.

`BoatVm.observe` writes what Boat said on the run's row (`created_seen_at`, or `absent_at` with its
basis) and nothing else. The run's runtime row and its capture record are written by the shared
paths, for Boat as for every runtime. A VM Boat lost under a live session is recorded `failed` /
`runtime-exited` by the exit reconciler and its work reported `gone` unless something on record says
it was saved (`reportsMissingAsLost`).

The worker's drains reach a Boat daemon through `BoatControlMaterial.drainMaterial`, which requires
only this deployment's run, on this sandbox, with its sealed bearer and Boat's labels on the VM.
Exec jobs and the API keep `connectMaterial`, which also requires a ready run that is not stopping.

## Convergence

`BoatConvergence.reconcile` runs every 30 s, a page at a time:

- **No VM.** A run whose create was never issued, or whose VM Boat never made: the shared stop never
  calls the adapter for a run that names no VM, so the conclusion that Boat holds none
  (`never-created`) and the release of its pin stay here. A create nobody can resolve is held for an
  operator; its owner's discard ends the session while the run's row and its pin stay held.
- **Cleanup.** What a VM Boat no longer has still holds is released (`cleanup`). A deletion Boat
  accepted whose operation is on record is polled here whatever a read of the VM says: a VM never
  seen past creation reads 404 as still being created, so presence alone would hold it for good.
- **The nudge.** For a run that is stopping or failed and still has a VM, the shared stop is called.
  The nudge decides nothing.

A VM kept because its FINAL cannot be confirmed is reported once an hour per run.

## A run without resources has no tunnel

A workspace created never to be linked to resources (`runtime.resources: "none"` in its stored spec)
is launched with no gateway, tunnel or port: the launch reads the option once and freezes it as
`resources: "none"` on the run's row, and readiness, the removal and every sweep read it from there.
Its stop is the same sequence with one difference: there is no tunnel to freeze, and nothing on a
gateway host to remove.

A deployment with no resource gateway (`BoatResourcesHost.gateway` absent) stops such runs and keeps
any run that has a tunnel: its work is saved, the removal is refused before Boat is asked (this
worker cannot remove the run's gateway), and its VM is kept until the gateway settings are back.

## Local proof and remaining gates

The PostgreSQL/HTTP suite covers successful FINAL and reuse, stop and launch fences, incomplete
FINAL, unknown host requests, lost and pending DELETE responses, exact target/label conflicts,
contradictory capture evidence, host cleanup failure, service restart, delayed receipts and
concurrent closes. The real Docker/WireGuard proof exercises linked-resource and DNS reach,
cross-project and host refusal, replay, and exact gateway/reach/egress cleanup. These are separate
local proofs; the HTTP fixture is not a real Boat deletion or a complete live close.

Issue #465 remains an admission blocker until the live end-to-end proof is integrated. Readiness PR
#468 requires the approved VM 131 networking to be live and its real end-to-end proof before merge.
This layer does not claim either gate. No provider allocation, actual Boat key read, box action or
Boat contact is needed for its local verification.

Snapshot parking (saving an idle session's disk as a Boat snapshot and removing its VM) was built
and then cut. Nothing saves a session's disk: what survives a stop is what FINAL captured.
