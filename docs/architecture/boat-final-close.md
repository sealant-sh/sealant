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
its sealed capture control but erasing its launch envelope. The guest's existing immutable
invocation record means a delayed start can only adopt that invocation, never start another after
FINAL. Unissued or ambiguous first launches are retained for a separate close/recovery path.

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

## Capture-only recovery

Before FINAL, the authenticated receiver observes the original invocation. If it is still running,
it returns that observation without stopping or starting anything. Otherwise it can issue one
capture-only recovery on the same disk and boot. Its immutable original admission must still be
present on protected tmpfs, including the exact launch and secret files. Every file is opened
without following symlinks, must be private and root-owned, and must match its admitted size and
hash. A missing file, changed boot, changed epoch or non-capture source refuses before closure.

The receiver durably closes ordinary launch replay before stopping the original service and its
mapped native child. It requires an empty workspace process census, the same isolation permit and
network, and a fresh shipped-code check. The separate `sealant-recovery.service` is static, has
`Restart=no`, uses the same resource slice and peer, and runs only `sealantd boot --recovery`. The
pinned daemon's recovery mode excludes materialization, dotfiles, lifecycle steps and harness
execution. No fresh launch payload is accepted. The original invocation record stays unchanged.

Recovery intent and invocation issuance are durable before dispatch. A lost start reply is
observe-only; neither a new request nor a new service invocation can replay it. A crash in the
pre-dispatch gap can retain an issued intent rather than infer that no start happened. Recovery
status and the control proxy pin the separate recovery process identities. Pending, ended,
unresolved or unreadable recovery retains the VM, native pin and port. FINAL proceeds only through
the exact running original or recovery daemon. A cold boot cannot reconstruct tmpfs through this
path. Snapshot hydration and fresh-epoch recovery belong to the canonical parking owner.

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

Provider deletion completion proves that the guest and its peer are gone. The host owner then
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
