# Boat FINAL close and tunnel release

`BoatFinalClose.close` closes an existing Boat allocation whose stop was requested. A bounded worker
sweep visits stopped current runtimes on its own gateway host, with its own cursor and four calls at
a time. Active, already removed and other-host runtimes are skipped. The runtime stays unregistered.
Generic Docker cleanup does not call this capability, and it does not admit a session. This is the
whole of a Boat stop: the FINAL drain, then the VM's deletion, then a poll of Boat's deletion
operation. A VM whose FINAL is incomplete stays until FINAL completes or the owner discards it; the
sweep closes it again on every pass. Resuming is a fresh VM from the project snapshot plus the
captured worktree.

## Before removal

The owner requires the same bound allocation, execution, provider sandbox, run, publication source,
boot, disk lineage and physical gateway host. The runtime row must still name that sandbox and have
an explicit stop reason. It holds an execution that was previously positively running, preserving
its sealed capture control but erasing its launch envelope. The agent's durable launch record means
a delayed push can only adopt that launch, never start another after FINAL. Unissued or ambiguous
first launches are retained for a separate close/recovery path.

Every host mutation is recorded before dispatch. A UUID fences subnet allocation and gateway ensure;
only its winning database transition permits dispatch. The UUID remains outstanding if the request
has an unknown outcome, including worker loss. A later successful setup cannot erase an earlier
uncertain request. The close barrier is irreversible and requires every outstanding request to have
positively returned. No lease expiry, timeout or empty Docker inventory substitutes for settlement.
A crash immediately after recording a host request can therefore retain its port indefinitely. This
conservative limitation needs positive host-operation reconciliation before admission can be
enabled.

A configuration holds the gateway host lock across its one gateway mutation, and the lock is tried,
never queued for. A close that meets it (a link job, the sweep's visit, a launch) has already held
the execution; it then tries the freeze again every 500 ms for up to 15 s, reading the reservation
again each time, and freezes as soon as the mutation returns. Nothing gets through while it waits: a
configuration reads the stop and the held execution before it dispatches, again under the lock. A
lock still held at 15 s, or any other failure of the freeze, fails the close as before, and the next
close pass finishes it. Only the close of a run that was issued waits; the close of a launch that
never issued fails at once.

The canonical capture drain sends FINAL through authenticated control and records every observation
in `workspace_capture_drains`. Empty queues do not count as FINAL completion. Incomplete,
unreadable, contradictory or unrecorded evidence retains the VM and its tunnel. The drain has a
60-second budget; the complete close call has a 120-second bound. A retry can drain the same held
daemon.

## Removal without the guest

Three facts let close remove a VM without the guest answering:

- **Absence.** Boat itself says the VM is gone: a typed 404 after Boat reported it past creation, or
  its own deletion operation completed. Close discharges the launch; nothing is asked of the guest
  and no DELETE is sent.
- **Discard.** The owner discarded the unsaved captures (`requestDiscard`). The VM is removed under
  the `discarded` basis and the capture ends `discarded`.
- **Attestation.** A trusted caller attested a sealed FINAL of this executor (`attestCompletion`)
  that covers everything Core observed of it. The VM is removed under `attested-complete` and the
  capture ends `stopped`, the same as an observed complete FINAL.

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

## Capture-only recovery

Before FINAL, close asks the [guest agent](boat-guest-agent.md) to recover the capture
(`POST /sealant/recover`, with the capture token Core kept sealed in the resume envelope). The agent
answers from its durable records, never from a guess: `running` (the daemon is up; FINAL drains it),
`restarted` (sealantd had exited 75 and was started again in recovery mode on the VM's own disk: the
VM is retained and the next pass observes it), or `nothing-to-save` (the daemon's recovery boot
exited 76 because it never materialized a capture, or this boot was bound and never launched). The
recovery boot runs no dotfiles, lifecycle step or harness, admits nothing, and resumes its own
staging.

`nothing-to-save` is a distinct execution result: nothing ran on the VM, so close removes it under
the `nothing-to-save` deletion basis, which rests on no recorded evidence a later observation could
revoke (like the owner's discard). The agent's refusals are typed (`recover-new-boot` after a
reboot, `recover-binding-conflict`, `recover-state-unknown` from a restarted agent that finds no
launch environment to adopt) and classified through the launch diagnostics; each retains the VM and
can never be read as nothing to save. A malformed answer or lost transport keeps the VM too and is
retried.

## Exact cleanup and retry

Only canonical deletion authorization and issuance permit DELETE. A fresh provider observation must
positively identify the same sandbox with all allocation ownership labels. Missing inventory is not
a deletion receipt. A lost DELETE response retains the issued obligation. If the same owned sandbox
is positively present and the canonical FINAL evidence still stands, a retry can repeat DELETE for
that stable sandbox ID. It never creates another VM.

The exact provider deletion operation ID is persisted on the allocation's own removal record, for
every run, before any wait: the allocation leaves `bound` for `deleting` with
`removal: { kind: "operation", id, targetId, completed }`. The allocation repository allows that
transition only once the execution can never start again: aborted before any launch was pushed, or
held, and from a held execution only with an operation record (hold comes before the drain, so held
alone lets nothing leave `bound`). Pending, blocked, transport loss and unknown outcomes keep the
port and host gateway. Observation of that operation can resume after worker loss without another
FINAL or DELETE. Changed operation IDs or target IDs refuse. Once exact completion is recorded, an
older pending response cannot downgrade it.

A run closed by a version that kept the operation on its tunnel reservation is still honoured: the
reservation's `removal` is read (never written again), its operation polled, and the result recorded
on the allocation from then on. No second DELETE is sent for it.

Provider deletion completion proves that the VM and its tunnel peer are gone. The host owner then
removes the exact owned gateway, detaches the reach network, and removes its egress network. It
positively rechecks all three names for absence. Only after that return can the canonical
transaction release the port. The transaction also requires a deleted capture root, held exact
execution, frozen close, completed exact provider removal and no outstanding host requests.

Released reservations remain immutable tombstones. A partial unique index excludes those tombstones
from active host-port exclusion, allowing the next execution to reserve the port while preserving
the old run's receipt. A retry after host cleanup failure repeats cleanup without another DELETE. A
retry after release finishes the runtime's terminal bookkeeping without touching a reused port. The
native publication pin is released by the discharge, once Boat reports the VM absent.

## One removal

`BoatRemoval.remove(allocation, { fence })` is the one deletion of a Boat VM. It decides nothing
about the work on the VM: its caller already holds what authorizes a DELETE (the ledger's deletion
ticket after an observed-complete FINAL, the owner's discard, or a launch that never ran). In order:

1. Observe the VM through the observer. If Boat no longer has it, discharge and stop.
2. If a deletion operation is on record, poll it. DELETE is never sent again.
3. Otherwise fence: with `fence: true` the removal holds a launched execution (or aborts one never
   pushed), freezes the run's tunnel if it has one, and claims a never-bound VM's allocation. With
   `fence: false` its caller did that where its own sequence needs it (the close holds and freezes
   before its FINAL drain) and the removal only verifies it. A run that is not stopping, not fenced,
   or whose VM does not carry its labels is sent nothing.
4. Send DELETE to the exact owned VM Boat just returned, record the operation on the allocation, and
   wait at most 20 s for `completed`.
5. On `completed`, record the absence (`deletion-completed`) and discharge: gateway removed and
   tunnel slot released if the run has one, allocation `deleted`, resume secrets forgotten,
   publication pin released. While Boat still says the deletion is in progress it answers `deleting`
   and releases nothing.

The removal is not the only observer of its own deletion. Boat answers 404 for the VM soon after a
DELETE, often while the operation still reads `processing`, and whatever reads the VM then (the
lifecycle sweep, a second stop, and from the next step on the exit reconciler's `inspect`) commits
that absence and may discharge on it. Once its DELETE is out, the removal therefore takes a
committed absence for the deletion's end wherever it meets one (an allocation another pass already
discharged, an operation it can no longer record or poll, a wait that ran out) and discharges in the
same call; the close does the same. Only the committed observation counts: a failed read, a timeout
and a 404 for a VM Boat was never seen to report past creation are not absence, nothing is released
before a committed absence, and no second DELETE is sent.

`close` and `closeUnused` call it. `close` uses its two halves (`deletion`, then the discharge)
because its capture ledger records the deletion between them.

`BoatRuntimeAdapter.stop()` is `remove` with `fence: true`, found by `(deployment_id, sandbox_id)`
(the runtime row's `reference` is rewritten to `boat:<sandbox>` and names no run). A deletion still
in progress, and every failure once Boat was asked, is `close-pending`: an outcome nobody knows yet.
Only a failure before Boat was asked anything is marked `removalRefused`. It declares no
`removalFenceMs`, since Boat states no bound on a deletion. Nothing calls it while stops still go
through `closeCapture` (see the guard below).

## What the runtime adapter reports (`inspect`)

Found by sandbox id:

- `missing`: only from a committed absence: Boat's typed 404 for a VM that was seen past creation,
  or a completed deletion operation.
- `exited` with `platformEnded: false`: the agent's health names `daemonExit`, or reports
  `booted: false`, or the row shows the launch was never pushed and the execution is fenced.
- `running`: everything else, including every failed, timed-out or unreadable read of Boat or the
  agent.

Boat and the agent are read at most once per VM per 60 s, and `running` is answered in between; once
a stop is requested for the run every call reads. Only `running` is ever answered without a read: an
`exited` or `missing` is never served from memory. The daemon's last output is redacted with the
run's bearer only.

With `inspect` present the generic exit reconciler sees Boat runs. While Boat still closes its own
executors (`closesItsOwnExecutors`, a guard removed with `closeCapture`) the generic paths do one
thing for a Boat run: a daemon that exited in a live VM is recorded `failed` / `runtime-exited` with
its retention, in one transaction. That hands it to this close owner, which recovers the daemon on
its own disk, drains FINAL and deletes the VM only once that is confirmed saved. They never probe or
drain its daemon, never authorize or issue a removal, never call `stop()`, and never record an
outcome for its work. A VM Boat no longer has is committed absent by the observer inside `inspect`;
the reconciler writes nothing, and this close discharges it exactly as when its own observation
found the absence.

Under the same guard the exit reconciler does not inspect a Boat run whose stop is requested: from
the stop request to the discharge the run is this close's, including a VM kept after an unconfirmed
FINAL. Nothing is read from Boat or the agent for it, so a stop has one observer of its deletion.

The worker's drains reach a Boat daemon through `BoatControlMaterial.drainMaterial`, which requires
only this deployment's run, on this sandbox, with its sealed bearer and Boat's labels on the VM.
Exec jobs and the API keep `connectMaterial`, which also requires a ready run that is not stopping.

## A run without resources has no tunnel

A workspace created never to be linked to resources (`runtime.resources: "none"` in its stored spec)
is launched with no gateway, tunnel or port: the launch reads the option once and freezes it as
`resources: "none"` on the allocation's input, and readiness, this close and every sweep read it
from there. Its close is the same sequence with one difference: there is no tunnel to freeze, and
nothing on a gateway host to remove.

1. The execution is held, then recovery and the FINAL drain run exactly as above (unless the owner
   discarded the work or a sealed FINAL was attested). There is no tunnel reservation to require or
   freeze; one recorded for such a run holds the close.
2. DELETE is authorized and issued through the same canonical ledger, after a fresh positive
   observation of the exact owned sandbox.
3. The operation id is recorded on the allocation's own removal record before any wait, as for every
   run.
4. Every later pass (a stop, the sweep, a restarted worker) finds the recorded operation and polls
   it. A different operation id or target refuses; completion never reverts.
5. Only once Boat reports `completed` is absence recorded (`deletion-completed`) and the discharge
   run: runtime row stopped and removed, capture state, allocation `deleted` (keeping the completed
   operation as its receipt), resume secrets forgotten, publication pin released. The allocation is
   never `deleted` before the absence is recorded, so a crash anywhere in this sequence is found and
   finished by the next sweep.

A launch that failed before its guest was reached is closed as an unused guest (`closeUnused`),
which never needed a tunnel. A lost DELETE reply leaves the allocation `bound` with the ledger's
removal still issued, and is settled as above: by Boat's own absence, or by asking again for the
same owned VM.

A deployment with no resource gateway (`BoatResourcesHost.gateway` absent) closes such runs and
holds any run that has a tunnel: its gateway is another deployment shape's to settle, and its VM is
kept until the gateway settings are back.

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
