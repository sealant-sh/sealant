# Boat FINAL close and tunnel release

`BoatFinalClose.close` closes an existing Boat allocation whose stop was requested. A bounded worker
sweep visits stopped current runtimes on its own gateway host, with its own cursor and four calls at
a time. Active, already removed and other-host runtimes are skipped. The runtime stays unregistered.
Generic Docker cleanup does not call this capability, and it does not admit a session. Roots already
enrolled in custody contract 3 are refused until the incarnation-aware parking executor exists.

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
launch environment to adopt, `parked`) and classified through the launch diagnostics; each retains
the VM and can never be read as nothing to save. A malformed answer or lost transport keeps the VM
too and is retried. Snapshot hydration and fresh-epoch recovery belong to the canonical parking
owner.

## A close that keeps the VM

When FINAL drains but the daemon cannot confirm the work saved (`unconfirmed`, `stalled`, or
`silent` while the VM runs, for example because Mend refuses the uploads), the close keeps the VM
and records the retention on the run's capture root (`retained_at`, with why). With automatic
parking on, that record is what enrolls the session for parking: the parking sweep takes over its
lineage, and the session is parked only once `SEALANT_BOAT_PARKING_DELAY_SECONDS` have passed since
the retention. Once the retention is recorded, a close (the stop job's or the lifecycle sweep's)
asks the guest nothing more and holds no drain lease, because parking cannot enroll a row a drain
holds; only the owner's discard or an attestation still closes the VM. From enrollment on, the
lifecycle sweep leaves the run to parking. With automatic parking off nothing is enrolled: the
lifecycle sweep keeps retrying FINAL and closes the session once it saves. Either way the legacy
recovery sweep never takes a Boat run. A FINAL whose queue is still moving, or one another close
holds, records nothing; the close that owns the drain decides. The agent's refusals and a pending
recovery boot keep the VM without recording a retention.

## Exact cleanup and retry

Only canonical deletion authorization and issuance permit DELETE. A fresh provider observation must
positively identify the same sandbox with all allocation ownership labels. Missing inventory is not
a deletion receipt. A lost DELETE response retains the issued obligation. If the same owned sandbox
is positively present and the canonical FINAL evidence still stands, a retry can repeat DELETE for
that stable sandbox ID. It never creates another VM.

The exact provider deletion operation ID is persisted. Pending, blocked, transport loss and unknown
outcomes keep the port and host gateway. Observation of that operation can resume after worker loss
without another FINAL or DELETE. Changed operation IDs or target IDs refuse. Once exact completion
is recorded, an older pending response cannot downgrade it.

Provider deletion completion proves that the VM and its tunnel peer are gone. The host owner then
removes the exact owned gateway, detaches the reach network, and removes its egress network. It
positively rechecks all three names for absence. Only after that return can the canonical
transaction release the port. The transaction also requires a deleted capture root, held exact
execution, frozen close, completed exact provider removal and no outstanding host requests.

Released reservations remain immutable tombstones. A partial unique index excludes those tombstones
from active host-port exclusion, allowing the next execution to reserve the port while preserving
the old run's receipt. A retry after host cleanup failure repeats cleanup without another DELETE. A
retry after release finishes the runtime's terminal bookkeeping without touching a reused port. The
native publication pin remains in custody for the later canonical incarnation/consumer owner.

## Local proof and remaining gates

The PostgreSQL/HTTP suite covers successful FINAL and reuse, stop and launch fences, incomplete
FINAL, unknown host requests, lost and pending DELETE responses, exact target/label conflicts,
contradictory capture evidence, host cleanup failure, service restart, delayed receipts and
concurrent closes. The real Docker/WireGuard proof exercises linked-resource and DNS reach,
cross-project and host refusal, replay, and exact gateway/reach/egress cleanup. These are separate
local proofs; the HTTP fixture is not a real Boat deletion or a complete live close.

Issue #465 remains an admission blocker until incarnation-aware recovery/parking and the live
end-to-end proof are integrated. Executable automatic parking is also a hard admission gate: an idle
session must be saved, its VM positively removed, and resume must restore its work intact. A local
close proof does not establish that gate. Readiness PR #468 requires the approved VM 131 networking
to be live and its real end-to-end proof before merge. This layer does not claim either gate. No
provider allocation, actual Boat key read, box action or Boat contact is needed for its local
verification.

Parking will run plain `sync` before stop as hygiene. The durability investigation found
user-created, edited, renamed and git files survived with or without it, so sync is not a lost-work
fix.
