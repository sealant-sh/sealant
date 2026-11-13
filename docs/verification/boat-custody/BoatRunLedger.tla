---------------------------- MODULE BoatRunLedger ----------------------------
(***************************************************************************)
(* Promise 1, the run ledger.                                              *)
(*                                                                         *)
(* Property: Core never records a Boat run as absent (never-created,       *)
(* not-found or deletion-completed), and so never stops tracking it, while *)
(* Boat may hold a VM for it.                                              *)
(* Harm: a VM bills by the second with no time limit, and nothing in Core  *)
(* will ever delete it.                                                    *)
(*                                                                         *)
(* One run, one idempotency key, so at most one VM (called "V"). Every     *)
(* step below is one SQL statement (or one transaction) or one HTTP call   *)
(* of the code named beside it; a process may stop between any two.        *)
(* Paths are relative to the repository root.                              *)
(*                                                                         *)
(*   vm.ts          packages/workspaces/src/runtime/boat/vm.ts             *)
(*   boat-runs.ts   packages/db/src/repositories/boat-runs.ts              *)
(*   removal.ts     packages/workspaces/src/runtime/boat/removal.ts        *)
(*   convergence.ts packages/workspaces/src/runtime/boat/convergence.ts    *)
(*   api.ts         packages/workspaces/src/runtime/boat/api.ts            *)
(*                                                                         *)
(* Boat is an adversary bounded by docs.boat.dev (api/v1.md "Idempotent    *)
(* sandbox creation", data-retention/delete.md): a create under a key Boat *)
(* already linked to a VM never makes a second VM; a create that failed    *)
(* before a VM existed releases its key (within about 2 minutes, here at   *)
(* any moment); any call may be refused or go unanswered; a reply may be   *)
(* lost after Boat acted; a request may reach Boat after Core gave up on   *)
(* it; the label listing may lag a create; a DELETE ends billing at once   *)
(* and its operation completes later. Where the docs are silent the        *)
(* constants below let the adversary do either.                            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Sweeps,       \* workers running BoatVm.reconcile (vm.ts) at once
    Inspectors,   \* other callers of BoatVm.observe: inspect, recovery (adapter.ts)
    MaxSends,     \* creates Core may send in one behaviour (first create plus replays)
    MaxLost,      \* replies Boat may lose after acting
    MaxRetries,   \* drive retries of the launch (vm.ts `prepared`: 119 in 120 s)
    MaxLapses,    \* lapses of a live launch's lease (a stalled worker, the database out of reach)
    MaxCrashes,   \* crashes of the launch's process
    \* The schedule the open finding P1-A needs. FALSE leaves it out (the gate case).
    SweepMayLoadDuringFirstCreate, \* a VM sweep loads the run as issued while its launch's first
                                   \* create is unanswered (a stop or a lapsed lease lets it)
    \* Boat's silences. TRUE lets the adversary do it.
    LimitCheckedBeforeKey,    \* a replay under a linked key refused for a limit, billing or a trial
    SnapshotCheckedBeforeKey, \* a replay under a linked key refused because its source snapshot is gone
    GetMay404WhileCreating,   \* GET answers 404 for a VM Boat is still creating
    SnapshotMayVanish,        \* the source snapshot is deleted while the run is open
    \* The code under check (vm.ts). See BoatRunLedger.cfg for main's values.
    FirstCreateRejectedKinds, \* `firstCreateRejected`: kinds that end the launch on its first create
    FirstRefusalRecords,      \* TRUE: that refusal records never-created at once (sealant#634 round 1)
    ReplayRejectedKinds,      \* `replayRejected`: kinds that record never-created on a replay
    \* Proposed fixes, not in the code (FALSE on main). See the skill's findings.
    MarkReplayBeforeSend,     \* a guarded statement marks the row before any replay is sent, and a
                              \* first create's refusal records never-created only if none was marked
    NotFoundNeedsSeenBeforeGet \* observe counts a 404 only if the row it read before the GET
                              \* already had created_seen_at

Launch      == "launch"
Removal     == "removal"
Convergence == "convergence"
Actors      == {Launch, Removal, Convergence} \cup Sweeps \cup Inspectors

(***************************************************************************)
(* Boat's answers to a create, one representative per class that the code *)
(* tells apart (failure.ts `kindByCode`, vm.ts `DEFINITE_REFUSALS`):       *)
(*   "key-expired"   the key or its permissions: key-refused, key-expired, *)
(*                   permission-missing, sandbox-outside-key,              *)
(*                   organization-mismatch. Checked before anything else.  *)
(*   "running-limit" the account: account-suspended, billing-required,     *)
(*                   running-limit, member-cap, trial-restricted,          *)
(*                   snapshot-allowance-full.                              *)
(*   "rate-limited"  rate-limited, no-machine (not definite).              *)
(*   "snapshot_not_found" the request's source snapshot is gone            *)
(*                   (snapshot_not_found, snapshot_data_expired).          *)
(*   "server-error"  5xx, 409 idempotency_in_progress, any other refusal.  *)
(*   "vm"            the VM (202, or a replay answered with the original). *)
(* "no-answer" is a call that ended without Boat's answer: timeout, reset, *)
(* a lost reply.                                                           *)
(***************************************************************************)
Kinds == {"vm", "key-expired", "running-limit", "rate-limited",
          "snapshot_not_found", "server-error"}

(***************************************************************************)
(* Main's code, in the model's kinds. The cases substitute these for the  *)
(* constants (`ReplayRejectedKinds <- CodeReplayRejected`); only a case    *)
(* that tests a variant sets its own. Change these when vm.ts changes.     *)
(***************************************************************************)
\* `firstCreateRejected`: a 4xx in DEFINITE_REFUSALS, or the source snapshot gone
CodeFirstCreateRejected == {"key-expired", "running-limit", "snapshot_not_found"}
\* the first create's refusal records never-created at once (`resolve`, phase reserved)
CodeFirstRefusalRecords == TRUE
\* `replayRejected`: snapshot_not_found or snapshot_data_expired, on a 4xx
CodeReplayRejected == {"snapshot_not_found"}

VARIABLES
    \* Boat
    vm,        \* "none" | "creating" | "created" | "deleted"
    listed,    \* Boat's label listing shows the VM (it may lag a create)
    key,       \* the run's idempotency key at Boat: "free" | "linked"
    snapshot,  \* the run's source snapshot: "ready" | "gone"
    boatOp,    \* Boat's deletion operation: "none" | "pending" | "completed"
    queue,     \* creates sent and not yet acted on by Boat (request ids)
    from,      \* request id -> the actor that sent it
    \* Core: the run's boat_runs row (boat-runs.ts) and its runtime row
    createIssued, \* create_issued_at is set
    replayIssued, \* (MarkReplayBeforeSend only) a replay was marked on the row
    sandbox,      \* sandbox_id: "null" | "V"
    held,         \* held_reason: "none" | "run-stopped" | "create-unresolved"
    absent,       \* absent_basis: "null" | "never-created" | "not-found" | "deletion-completed"
    createdSeen,  \* created_seen_at is set
    claimed,      \* deletion_claimed_at is a live claim
    coreOp,       \* deletion_operation_id recorded: "null" | "pending" | "completed"
    status,       \* workspace_runtime_instances.status: "pending" | "ready" | "failed" | "stopped"
    stopAsked,    \* workspace_runtime_instances.stop_reason is set
    stopJob,      \* the stop job (process-workspace-stop.ts): "none" | "mark" | "done"
    lease,        \* the launch owner's lease has not lapsed
    window,       \* createAgeMs < BOAT_CREATE_REPLAY_WINDOW_MS (23 h)
    \* actors
    pc, awaiting, inbox, seenPhase, got,
    \* bounds
    sends, lost, retries, lapses, crashes, stops

boatVars  == <<vm, listed, key, snapshot, boatOp, queue, from>>
rowVars   == <<createIssued, replayIssued, sandbox, held, absent, createdSeen, claimed, coreOp>>
envVars   == <<status, stopAsked, stopJob, lease, window>>
actorVars == <<pc, awaiting, inbox, seenPhase, got>>
boundVars == <<sends, lost, retries, lapses, crashes, stops>>
vars      == <<boatVars, rowVars, envVars, actorVars, boundVars>>

-----------------------------------------------------------------------------
(* Reads of Core's rows *)

\* boatRunVmPhase (packages/validators/src/workspaces/boat-run.ts)
Phase ==
    IF absent # "null" THEN "deleted"
    ELSE IF claimed \/ coreOp # "null" THEN "deleting"
    ELSE IF held # "none" THEN "held"
    ELSE IF sandbox = "null" THEN (IF createIssued THEN "issued" ELSE "reserved")
    ELSE "allocated"

Active         == status \in {"pending", "ready"} /\ ~stopAsked   \* BoatRunRepo.isActive
LaunchInFlight == status = "pending" /\ lease                     \* BoatRunRepo.launchInFlight
Stopping       == stopAsked \/ status = "failed"                  \* removal.ts `stopping`

(* Guarded statements of boat-runs.ts, as their WHERE clauses say *)

IssueGuard ==   \* issueCreate
    ~createIssued /\ sandbox = "null" /\ held = "none" /\ absent = "null"
    /\ status = "pending" /\ ~stopAsked

AdoptGuard ==   \* adopt (with its runtime-row projection, one transaction)
    sandbox = "null" /\ createIssued /\ absent = "null"
    /\ held \in {"none", "create-unresolved"}

HoldGuard(reason) ==   \* hold
    held = "none" /\ absent = "null" /\ ~claimed /\ coreOp = "null"
    /\ sandbox = "null"
    /\ IF reason = "run-stopped" THEN ~createIssued ELSE createIssued

\* recordNeverCreated: UPDATE ... WHERE sandbox_id IS NULL AND absent_at IS NULL
RecordNeverCreated ==
    IF sandbox = "null" /\ absent = "null"
    THEN absent' = "never-created" /\ held' = "none"
    ELSE UNCHANGED <<absent, held>>

\* recordNeverCreated after the first create's refusal (vm.ts `resolve`, phase reserved)
RecordNeverCreatedFirst ==
    IF MarkReplayBeforeSend /\ replayIssued
    THEN UNCHANGED <<absent, held>>
    ELSE RecordNeverCreated

\* (MarkReplayBeforeSend) UPDATE ... SET replay_issued_at WHERE absent_at IS NULL
MarkReplayGuard == absent = "null"

\* recordNotFound: UPDATE ... WHERE sandbox_id = V AND absent_at IS NULL AND created_seen_at IS NOT NULL
RecordNotFound ==
    IF sandbox = "V" /\ absent = "null" /\ createdSeen
    THEN absent' = "not-found" /\ held' = "none"
    ELSE UNCHANGED <<absent, held>>

\* seen(created = TRUE): UPDATE ... SET created_seen_at WHERE ... AND absent_at IS NULL
Seen == createdSeen' = (createdSeen \/ (sandbox = "V" /\ absent = "null"))

\* recordDeletion: one UPDATE; `completed` records absence in the same statement
RecordDeletion(op) ==
    IF sandbox = "V" /\ absent = "null" /\ coreOp \in {"null", op, "pending"} /\ Stopping
    THEN /\ coreOp' = op
         /\ IF op = "completed"
            THEN absent' = "deletion-completed" /\ held' = "none"
            ELSE UNCHANGED <<absent, held>>
    ELSE UNCHANGED <<coreOp, absent, held>>

-----------------------------------------------------------------------------
(* Boat *)

\* What Boat may do with one create request (api/v1.md "Idempotent sandbox creation").
CreateAnswers ==
    IF key = "free"
    THEN { [make |-> TRUE, reply |-> r] :
              r \in (IF snapshot = "ready" THEN {"vm", "server-error", "no-answer"} ELSE {}) }
         \cup
         { [make |-> FALSE, reply |-> r] :
              r \in {"key-expired", "running-limit", "rate-limited", "server-error", "no-answer"}
                    \cup (IF snapshot = "gone" THEN {"snapshot_not_found"} ELSE {}) }
    ELSE { [make |-> FALSE, reply |-> r] :
              r \in {"vm", "key-expired", "server-error", "no-answer"}
                    \cup (IF LimitCheckedBeforeKey THEN {"running-limit", "rate-limited"} ELSE {})
                    \cup (IF snapshot = "gone" /\ SnapshotCheckedBeforeKey
                          THEN {"snapshot_not_found"} ELSE {}) }

\* GET /sandboxes?label=... over every page (api.ts `discover`)
ListResults ==
    (IF vm \in {"creating", "created"} /\ listed THEN {"found"} ELSE {"empty"})
    \cup {"unavailable"}

\* GET /sandboxes/V (api.ts `get`)
GetResults ==
    (CASE vm = "none"     -> {"404"}
       [] vm = "creating" -> {"creating"} \cup (IF GetMay404WhileCreating THEN {"404"} ELSE {})
       [] vm = "created"  -> {"created"}
       [] vm = "deleted"  -> {"404"})
    \cup {"unavailable"}

\* What observe takes from the GET (vm.ts `observe`). With NotFoundNeedsSeenBeforeGet a 404
\* read while the row did not yet have created_seen_at is "unknown, creating": nothing written.
ObservedGet ==
    IF NotFoundNeedsSeenBeforeGet /\ ~createdSeen
    THEN {IF r = "404" THEN "404-unseen" ELSE r : r \in GetResults}
    ELSE GetResults

\* Boat acts on create request i: makes the VM or refuses, and answers or not.
BoatActsOnCreate(i) ==
    /\ i \in queue
    /\ \E ans \in CreateAnswers :
         /\ ans.reply = "no-answer" => lost < MaxLost
         /\ queue' = queue \ {i}
         /\ IF ans.make THEN vm' = "creating" /\ key' = "linked"
                        ELSE UNCHANGED <<vm, key>>
         /\ lost' = IF ans.reply = "no-answer" THEN lost + 1 ELSE lost
         \* A reply reaches only a sender still waiting for this request.
         /\ inbox' = IF awaiting[from[i]] = i /\ ans.reply # "no-answer"
                     THEN [inbox EXCEPT ![from[i]] = ans.reply]
                     ELSE inbox
    /\ UNCHANGED <<listed, snapshot, boatOp, from, rowVars, envVars,
                   pc, awaiting, seenPhase, got, sends, retries, lapses, crashes, stops>>

VmFinishesCreating ==
    /\ vm = "creating" /\ vm' = "created"
    /\ UNCHANGED <<listed, key, snapshot, boatOp, queue, from, rowVars, envVars, actorVars, boundVars>>

ListingCatchesUp ==
    /\ vm \in {"creating", "created"} /\ ~listed /\ listed' = TRUE
    /\ UNCHANGED <<vm, key, snapshot, boatOp, queue, from, rowVars, envVars, actorVars, boundVars>>

DeletionCompletes ==
    /\ boatOp = "pending" /\ boatOp' = "completed"
    /\ UNCHANGED <<vm, listed, key, snapshot, queue, from, rowVars, envVars, actorVars, boundVars>>

SnapshotVanishes ==
    /\ SnapshotMayVanish /\ snapshot = "ready" /\ snapshot' = "gone"
    /\ UNCHANGED <<vm, listed, key, boatOp, queue, from, rowVars, envVars, actorVars, boundVars>>

-----------------------------------------------------------------------------
(* The world around the run *)

\* The launch's lease lapses: its worker stalled or lost the database for 2 min
\* (process-workspace-build-job.ts `renewLaunchLease`), or its process died.
LeaseLapses ==
    /\ lease
    /\ pc[Launch] = "dead" \/ lapses < MaxLapses
    /\ lease' = FALSE
    /\ lapses' = IF pc[Launch] = "dead" THEN lapses ELSE lapses + 1
    /\ UNCHANGED <<boatVars, rowVars, status, stopAsked, stopJob, window, actorVars,
                   sends, lost, retries, crashes, stops>>

\* Someone asks the run to stop (the owner, the expiry reaper, the stranded-launch sweep).
StopAsked ==
    /\ ~stopAsked /\ stops < 1
    /\ stopAsked' = TRUE /\ stops' = stops + 1
    /\ UNCHANGED <<boatVars, rowVars, status, stopJob, lease, window, actorVars,
                   sends, lost, retries, lapses, crashes>>

\* The stop job (processWorkspaceStop): reads the runtime row; a run with no VM on record
\* (resource_id null) skips the adapter and is recorded stopped by markStopped, an UPDATE guarded
\* only on status <> 'stopped', whatever its launch is doing. One with a VM goes to the adapter,
\* whose removal is the Removal actor below.
StopJobReads ==
    /\ stopAsked /\ stopJob = "none" /\ status # "stopped"
    /\ stopJob' = IF sandbox = "null" THEN "mark" ELSE "done"
    /\ UNCHANGED <<boatVars, rowVars, status, stopAsked, lease, window, actorVars, boundVars>>

StopJobMarksStopped ==
    /\ stopJob = "mark"
    /\ status' = "stopped" /\ stopJob' = "done"
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, lease, window, actorVars, boundVars>>

\* 23 hours pass since create_issued_at.
WindowCloses ==
    /\ window /\ createIssued /\ window' = FALSE
    /\ UNCHANGED <<boatVars, rowVars, status, stopAsked, stopJob, lease, actorVars, boundVars>>

-----------------------------------------------------------------------------
(* Helpers for actors *)

Goto(a, next) == pc' = [pc EXCEPT ![a] = next]

\* Sends one create (api.ts `create`, same key and body every time).
Send(a, next) ==
    /\ sends < MaxSends
    /\ sends' = sends + 1
    /\ queue' = queue \cup {sends + 1}
    /\ from' = [from EXCEPT ![sends + 1] = a]
    /\ awaiting' = [awaiting EXCEPT ![a] = sends + 1]
    /\ inbox' = [inbox EXCEPT ![a] = "none"]
    /\ Goto(a, next)

\* What the call answered: Boat's reply, or "no-answer" when it ended without one
\* (a timeout or a lost reply; Boat may still act on the request later).
Answers(a) == IF inbox[a] # "none" THEN {inbox[a]} ELSE {"no-answer"}

Done(a) == /\ awaiting' = [awaiting EXCEPT ![a] = 0]
           /\ inbox' = [inbox EXCEPT ![a] = "none"]

\* The launch ends: its job writes the runtime row (process-workspace-build-job.ts).
LaunchEnds(ok) ==
    /\ Goto(Launch, "done")
    /\ status' = IF status = "stopped" THEN "stopped" ELSE IF ok THEN "ready" ELSE "failed"
    /\ lease' = FALSE

\* vm.ts `prepared`: an allocation-pending create or creating VM is retried, within budget.
LaunchRetry ==
    IF retries < MaxRetries
    THEN Goto(Launch, "load") /\ retries' = retries + 1 /\ UNCHANGED <<status, lease>>
    ELSE LaunchEnds(FALSE) /\ UNCHANGED retries

-----------------------------------------------------------------------------
(* The launch: BoatVm.prepare -> drive -> resolve (vm.ts) *)

\* resolve: load the row, read its phase (and isActive for a reserved run)
LLoad ==
    /\ pc[Launch] = "load"
    /\ LET ph == Phase
           unresolved == held = "create-unresolved"
       IN CASE ph \in {"held", "deleting", "deleted"} /\ ~unresolved ->
                  LaunchEnds(FALSE) /\ UNCHANGED seenPhase
            [] ph = "reserved" /\ ~Active ->
                  Goto(Launch, "holdStopped") /\ UNCHANGED <<seenPhase, status, lease>>
            [] ph = "reserved" ->
                  Goto(Launch, "readSource") /\ UNCHANGED <<seenPhase, status, lease>>
            [] ph = "allocated" ->
                  Goto(Launch, "get") /\ UNCHANGED <<seenPhase, status, lease>>
            [] OTHER ->   \* issued, or held create-unresolved
                  /\ Goto(Launch, "discover")
                  /\ seenPhase' = [seenPhase EXCEPT ![Launch] = ph]
                  /\ UNCHANGED <<status, lease>>
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, awaiting, inbox, got, boundVars>>

\* runs.hold(runId, "run-stopped")
LHoldStopped ==
    /\ pc[Launch] = "holdStopped"
    /\ held' = IF HoldGuard("run-stopped") THEN "run-stopped" ELSE held
    /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, absent, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* api.getSnapshot(expected.name): the source must be ready
LReadSource ==
    /\ pc[Launch] = "readSource"
    /\ IF snapshot = "ready"
       THEN \/ Goto(Launch, "issue") /\ UNCHANGED <<status, lease>>
            \/ LaunchEnds(FALSE)            \* Boat did not answer the read
       ELSE LaunchEnds(FALSE)               \* source-mismatch
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* runs.issueCreate(runId): one guarded UPDATE; only its winner sends the first create
LIssue ==
    /\ pc[Launch] = "issue"
    /\ IF IssueGuard
       THEN createIssued' = TRUE /\ Goto(Launch, "sendFirst") /\ UNCHANGED <<status, lease>>
       ELSE UNCHANGED createIssued /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, sandbox, held, absent, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* api.create(...): the first create under the run's key
LSendFirst ==
    /\ pc[Launch] = "sendFirst"
    /\ Send(Launch, "awaitFirst")
    /\ UNCHANGED <<vm, listed, key, snapshot, boatOp, rowVars, envVars, seenPhase, got,
                   lost, retries, lapses, crashes, stops>>

\* the first create's reply: `firstCreateRejected`, adopt, or allocation-pending
LReplyFirst ==
    /\ pc[Launch] = "awaitFirst"
    /\ \E r \in Answers(Launch) :
         /\ Done(Launch)
         /\ CASE r = "vm" ->
                   Goto(Launch, "adopt") /\ UNCHANGED <<status, lease, retries>>
              [] r \in FirstCreateRejectedKinds ->
                   IF FirstRefusalRecords
                   THEN Goto(Launch, "neverFirst") /\ UNCHANGED <<status, lease, retries>>
                   ELSE LaunchEnds(FALSE) /\ UNCHANGED retries
              [] OTHER -> LaunchRetry
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, seenPhase, got,
                   sends, lost, lapses, crashes, stops>>

\* runs.recordNeverCreated(runId) after a refusal of the first create
LNeverFirst ==
    /\ pc[Launch] = "neverFirst"
    /\ RecordNeverCreatedFirst
    /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* api.discover(ownership)
LDiscover ==
    /\ pc[Launch] = "discover"
    /\ \E res \in ListResults :
         CASE res = "found" -> Goto(Launch, "adopt") /\ UNCHANGED <<status, lease>>
           [] res = "empty" -> Goto(Launch, "age") /\ UNCHANGED <<status, lease>>
           [] OTHER         -> LaunchEnds(FALSE)       \* provider-unavailable
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* runs.createAgeMs(runId) against the replay window
LAge ==
    /\ pc[Launch] = "age"
    /\ IF window
       THEN Goto(Launch, IF MarkReplayBeforeSend THEN "markReplay" ELSE "sendReplay")
            /\ UNCHANGED <<status, lease>>
       ELSE IF seenPhase[Launch] = "issued"
            THEN Goto(Launch, "holdUnresolved") /\ UNCHANGED <<status, lease>>
            ELSE LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* (MarkReplayBeforeSend) mark the row; a row already absent sends nothing
LMarkReplay ==
    /\ pc[Launch] = "markReplay"
    /\ IF MarkReplayGuard
       THEN replayIssued' = TRUE /\ Goto(Launch, "sendReplay") /\ UNCHANGED <<status, lease>>
       ELSE UNCHANGED replayIssued /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, createIssued, sandbox, held, absent, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* runs.hold(runId, "create-unresolved")
LHoldUnresolved ==
    /\ pc[Launch] = "holdUnresolved"
    /\ held' = IF HoldGuard("create-unresolved") THEN "create-unresolved" ELSE held
    /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, absent, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* api.create(...) again under the same key: a replay
LSendReplay ==
    /\ pc[Launch] = "sendReplay"
    /\ Send(Launch, "awaitReplay")
    /\ UNCHANGED <<vm, listed, key, snapshot, boatOp, rowVars, envVars, seenPhase, got,
                   lost, retries, lapses, crashes, stops>>

\* the replay's reply: adopt, `replayRejected` while issued, or allocation-pending
LReplyReplay ==
    /\ pc[Launch] = "awaitReplay"
    /\ \E r \in Answers(Launch) :
         /\ Done(Launch)
         /\ CASE r = "vm" ->
                   Goto(Launch, "adopt") /\ UNCHANGED <<status, lease, retries>>
              [] r \in ReplayRejectedKinds /\ seenPhase[Launch] = "issued" ->
                   Goto(Launch, "neverReplay") /\ UNCHANGED <<status, lease, retries>>
              [] OTHER -> LaunchRetry
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, seenPhase, got,
                   sends, lost, lapses, crashes, stops>>

\* runs.recordNeverCreated(runId) after a refused replay
LNeverReplay ==
    /\ pc[Launch] = "neverReplay"
    /\ RecordNeverCreated
    /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* runs.adopt(runId, sandbox.id)
LAdopt ==
    /\ pc[Launch] = "adopt"
    /\ IF AdoptGuard
       THEN sandbox' = "V" /\ held' = "none" /\ Goto(Launch, "get") /\ UNCHANGED <<status, lease>>
       ELSE UNCHANGED <<sandbox, held>> /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, absent, createdSeen, claimed, coreOp,
                   stopAsked, stopJob, window, awaiting, inbox, seenPhase, got, boundVars>>

\* drive -> observe: runs.get, then api.get(V) (the row read only gates; merging it is exact)
LGet ==
    /\ pc[Launch] = "get"
    /\ IF absent # "null"
       THEN LaunchEnds(FALSE) /\ UNCHANGED got
       ELSE \E res \in ObservedGet :
              /\ got' = [got EXCEPT ![Launch] = res]
              /\ Goto(Launch, "observeWrite")
              /\ UNCHANGED <<status, lease>>
    /\ UNCHANGED <<boatVars, rowVars, stopAsked, stopJob, window, awaiting, inbox, seenPhase, boundVars>>

\* observe's write: runs.seen or runs.recordNotFound, then drive decides
LObserveWrite ==
    /\ pc[Launch] = "observeWrite"
    /\ LET res == got[Launch] IN
         CASE res = "created" ->
                  /\ Seen
                  /\ UNCHANGED <<absent, held, retries>>
                  \* isActive (else run-stopped), then bind, exchange, ready
                  /\ LaunchEnds(absent = "null" /\ Active)
           [] res = "creating" ->                  \* allocation-pending, retried
                  /\ UNCHANGED <<createdSeen, absent, held>>
                  /\ IF absent = "null"
                     THEN LaunchRetry
                     ELSE LaunchEnds(FALSE) /\ UNCHANGED retries
           [] res = "404" ->
                  /\ RecordNotFound
                  /\ UNCHANGED <<createdSeen, retries>>
                  /\ LaunchEnds(FALSE)
           [] OTHER ->
                  /\ UNCHANGED <<createdSeen, absent, held, retries>>
                  /\ LaunchEnds(FALSE)
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, claimed, coreOp, stopAsked, stopJob, window,
                   awaiting, inbox, seenPhase, got, sends, lost, lapses, crashes, stops>>

\* The launch's process dies between two steps. Its request may still reach Boat.
LCrash ==
    /\ pc[Launch] \notin {"done", "dead"}
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ Goto(Launch, "dead")
    /\ Done(Launch)
    /\ UNCHANGED <<boatVars, rowVars, envVars, seenPhase, got, sends, lost, retries, lapses, stops>>

-----------------------------------------------------------------------------
(* The VM sweep: BoatVm.reconcile -> resolve(id, undefined) (vm.ts), one per worker *)

\* listUnresolved + load + launchInFlight: a live launch owns its run
SCheck(s) ==
    /\ pc[s] = "idle"
    /\ sandbox = "null" /\ absent = "null" /\ ~LaunchInFlight
    /\ Goto(s, "load")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* resolve: load the row and read its phase
SLoad(s) ==
    /\ pc[s] = "load"
    /\ \/ SweepMayLoadDuringFirstCreate
       \/ Phase # "issued"
       \/ pc[Launch] \notin {"sendFirst", "awaitFirst", "neverFirst"}
    /\ LET ph == Phase
           unresolved == held = "create-unresolved"
       IN CASE ph \in {"held", "deleting", "deleted"} /\ ~unresolved ->
                  Goto(s, "idle") /\ UNCHANGED seenPhase
            [] ph = "reserved" ->
                  Goto(s, "checkActive") /\ UNCHANGED seenPhase
            [] ph = "allocated" ->
                  Goto(s, "idle") /\ UNCHANGED seenPhase
            [] OTHER ->
                  Goto(s, "discover") /\ seenPhase' = [seenPhase EXCEPT ![s] = ph]
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, got, boundVars>>

\* runs.isActive(runId) for a reserved run: a stopped one is held; a live one waits for its launch
SCheckActive(s) ==
    /\ pc[s] = "checkActive"
    /\ Goto(s, IF Active THEN "idle" ELSE "holdStopped")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

SHoldStopped(s) ==
    /\ pc[s] = "holdStopped"
    /\ held' = IF HoldGuard("run-stopped") THEN "run-stopped" ELSE held
    /\ Goto(s, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, absent, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

SDiscover(s) ==
    /\ pc[s] = "discover"
    /\ \E res \in ListResults :
         Goto(s, CASE res = "found" -> "adopt" [] res = "empty" -> "age" [] OTHER -> "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

SAge(s) ==
    /\ pc[s] = "age"
    /\ Goto(s, IF window THEN (IF MarkReplayBeforeSend THEN "markReplay" ELSE "sendReplay")
               ELSE IF seenPhase[s] = "issued" THEN "holdUnresolved" ELSE "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

SMarkReplay(s) ==
    /\ pc[s] = "markReplay"
    /\ IF MarkReplayGuard
       THEN replayIssued' = TRUE /\ Goto(s, "sendReplay")
       ELSE UNCHANGED replayIssued /\ Goto(s, "idle")
    /\ UNCHANGED <<boatVars, createIssued, sandbox, held, absent, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

SHoldUnresolved(s) ==
    /\ pc[s] = "holdUnresolved"
    /\ held' = IF HoldGuard("create-unresolved") THEN "create-unresolved" ELSE held
    /\ Goto(s, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, absent, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

SSendReplay(s) ==
    /\ pc[s] = "sendReplay"
    /\ Send(s, "awaitReplay")
    /\ UNCHANGED <<vm, listed, key, snapshot, boatOp, rowVars, envVars, seenPhase, got,
                   lost, retries, lapses, crashes, stops>>

SReplyReplay(s) ==
    /\ pc[s] = "awaitReplay"
    /\ \E r \in Answers(s) :
         /\ Done(s)
         /\ Goto(s, CASE r = "vm" -> "adopt"
                      [] r \in ReplayRejectedKinds /\ seenPhase[s] = "issued" -> "never"
                      [] OTHER -> "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, seenPhase, got, boundVars>>

SAdopt(s) ==
    /\ pc[s] = "adopt"
    /\ IF AdoptGuard THEN sandbox' = "V" /\ held' = "none" ELSE UNCHANGED <<sandbox, held>>
    /\ Goto(s, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, absent, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

SNever(s) ==
    /\ pc[s] = "never"
    /\ RecordNeverCreated
    /\ Goto(s, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* The sweep's worker dies, or its 120 s bound per entry ends the pass.
SAbort(s) ==
    /\ pc[s] # "idle"
    /\ Goto(s, "idle")
    /\ Done(s)
    /\ UNCHANGED <<boatVars, rowVars, envVars, seenPhase, got, boundVars>>

-----------------------------------------------------------------------------
(* The convergence sweep, for a run with no VM (convergence.ts `step`) *)

\* runs.get: stopped before create was ever issued
CRead ==
    /\ pc[Convergence] = "idle"
    /\ sandbox = "null" /\ absent = "null" /\ held = "run-stopped"
    /\ Goto(Convergence, "never")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

CNever ==
    /\ pc[Convergence] = "never"
    /\ RecordNeverCreated
    /\ Goto(Convergence, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, createdSeen, claimed, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

CAbort ==
    /\ pc[Convergence] # "idle"
    /\ Goto(Convergence, "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

-----------------------------------------------------------------------------
(* The removal of a stopping run's VM: BoatRemoval.remove (removal.ts) *)

\* stored(run): a stopping run with a VM and no absence; poll a recorded operation
RStart ==
    /\ pc[Removal] = "idle"
    /\ Stopping /\ sandbox = "V" /\ absent = "null"
    /\ Goto(Removal, IF coreOp # "null" THEN "poll" ELSE "get")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* observe: api.get(V)
RGet ==
    /\ pc[Removal] = "get"
    /\ IF absent # "null"
       THEN Goto(Removal, "idle") /\ UNCHANGED got
       ELSE \E res \in ObservedGet :
              got' = [got EXCEPT ![Removal] = res] /\ Goto(Removal, "observeWrite")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, boundVars>>

\* observe's write, then: present -> authorize, fence, claim; otherwise stop here
RObserveWrite ==
    /\ pc[Removal] = "observeWrite"
    /\ LET res == got[Removal]
           \* present: authorize (a VM a daemon may have run on needs the caller's
           \* authorization, which may be missing), fence, then claim
           next == IF absent = "null" THEN {"claim", "idle"} ELSE {"idle"}
       IN CASE res = "created" ->
                  /\ Seen
                  /\ UNCHANGED <<absent, held>>
                  /\ \E n \in next : Goto(Removal, n)
            [] res = "creating" ->
                  /\ UNCHANGED <<createdSeen, absent, held>>
                  /\ \E n \in next : Goto(Removal, n)
            [] res = "404" ->
                  /\ RecordNotFound
                  /\ UNCHANGED createdSeen
                  /\ Goto(Removal, "idle")
            [] OTHER ->
                  /\ UNCHANGED <<createdSeen, absent, held>>
                  /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, claimed, coreOp, envVars,
                   awaiting, inbox, seenPhase, got, boundVars>>

\* runs.claimDeletion(runId, BOAT_REMOVAL_CLAIM_MS)
RClaim ==
    /\ pc[Removal] = "claim"
    /\ IF sandbox = "V" /\ absent = "null" /\ coreOp = "null" /\ ~claimed /\ Stopping
       THEN claimed' = TRUE /\ Goto(Removal, "delete")
       ELSE UNCHANGED claimed /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, held, absent, createdSeen, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* api.deleteSandbox(V): Boat stops the VM at once (billing ends), the operation completes later
RDelete ==
    /\ pc[Removal] = "delete"
    /\ \/ /\ vm \in {"creating", "created"}
          /\ vm' = "deleted"
          /\ listed' = FALSE
          /\ \E op \in {"pending", "completed"} :
               /\ boatOp' = op
               /\ \/ /\ got' = [got EXCEPT ![Removal] = op]
                     /\ Goto(Removal, "record")
                     /\ UNCHANGED lost
                  \/ /\ lost < MaxLost      \* Boat deleted it and the reply was lost
                     /\ lost' = lost + 1
                     /\ UNCHANGED got
                     /\ Goto(Removal, "lapse")
       \/ /\ UNCHANGED <<vm, listed, boatOp, got, lost>>   \* refused, or no answer before Boat acted
          /\ Goto(Removal, "lapse")
    /\ UNCHANGED <<key, snapshot, queue, from, rowVars, envVars, awaiting, inbox, seenPhase,
                   sends, retries, lapses, crashes, stops>>

\* runs.lapseDeletionClaim(claimed)
RLapse ==
    /\ pc[Removal] = "lapse"
    /\ claimed' = IF coreOp = "null" /\ absent = "null" THEN FALSE ELSE claimed
    /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, held, absent, createdSeen, coreOp,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* runs.recordDeletion(runId, operation)
RRecord ==
    /\ pc[Removal] = "record"
    /\ RecordDeletion(got[Removal])
    /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, createdSeen, claimed,
                   envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* api.getDeletion(id) for a recorded operation
RPoll ==
    /\ pc[Removal] = "poll"
    /\ \/ /\ boatOp = "completed"
          /\ got' = [got EXCEPT ![Removal] = "completed"]
          /\ Goto(Removal, "record")
       \/ /\ UNCHANGED got                  \* still pending, or Boat did not answer
          /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, boundVars>>

RAbort ==
    /\ pc[Removal] # "idle"
    /\ Goto(Removal, "idle")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, got, boundVars>>

\* BOAT_REMOVAL_CLAIM_MS passes on a claim whose DELETE was never answered
RClaimLapses ==
    /\ pc[Removal] = "idle" /\ claimed /\ coreOp = "null"
    /\ claimed' = FALSE
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, held, absent, createdSeen, coreOp,
                   envVars, actorVars, boundVars>>

-----------------------------------------------------------------------------
(* Other observers of the VM (adapter.ts): the exit reconciler's `inspect` reads   *)
(* `ready` runs (reconcile-runtime-exits.ts `listRunningInstances`) and ended      *)
(* capture executors; recovery (`recover`) reads stopping or failed runs.          *)

IGet(i) ==
    /\ pc[i] = "idle"
    /\ sandbox = "V" /\ absent = "null"
    /\ status = "ready" \/ Stopping
    /\ \E res \in ObservedGet : got' = [got EXCEPT ![i] = res] /\ Goto(i, "observeWrite")
    /\ UNCHANGED <<boatVars, rowVars, envVars, awaiting, inbox, seenPhase, boundVars>>

IObserveWrite(i) ==
    /\ pc[i] = "observeWrite"
    /\ CASE got[i] = "created" -> Seen /\ UNCHANGED <<absent, held>>
         [] got[i] = "404"     -> RecordNotFound /\ UNCHANGED createdSeen
         [] OTHER              -> UNCHANGED <<createdSeen, absent, held>>
    /\ Goto(i, "idle")
    /\ UNCHANGED <<boatVars, replayIssued, createIssued, sandbox, claimed, coreOp, envVars,
                   awaiting, inbox, seenPhase, got, boundVars>>

-----------------------------------------------------------------------------

Init ==
    /\ vm = "none" /\ listed = FALSE /\ key = "free" /\ snapshot = "ready"
    /\ boatOp = "none" /\ queue = {} /\ from = [i \in 1..MaxSends |-> Launch]
    \* BoatRunRepo.reserve has committed: the row and its pending runtime row exist.
    /\ createIssued = FALSE /\ replayIssued = FALSE /\ sandbox = "null"
    /\ held = "none" /\ absent = "null"
    /\ createdSeen = FALSE /\ claimed = FALSE /\ coreOp = "null"
    /\ status = "pending" /\ stopAsked = FALSE /\ stopJob = "none" /\ lease = TRUE /\ window = TRUE
    /\ pc = [a \in Actors |-> IF a = Launch THEN "load" ELSE "idle"]
    /\ awaiting = [a \in Actors |-> 0]
    /\ inbox = [a \in Actors |-> "none"]
    /\ seenPhase = [a \in Actors |-> "none"]
    /\ got = [a \in Actors |-> "none"]
    /\ sends = 0 /\ lost = 0 /\ retries = 0 /\ lapses = 0 /\ crashes = 0 /\ stops = 0

Next ==
    \/ \E i \in 1..MaxSends : BoatActsOnCreate(i)
    \/ VmFinishesCreating \/ ListingCatchesUp \/ DeletionCompletes \/ SnapshotVanishes
    \/ LeaseLapses \/ StopAsked \/ StopJobReads \/ StopJobMarksStopped \/ WindowCloses
    \/ LLoad \/ LHoldStopped \/ LReadSource \/ LIssue \/ LSendFirst \/ LReplyFirst
    \/ LNeverFirst \/ LDiscover \/ LAge \/ LMarkReplay \/ LHoldUnresolved \/ LSendReplay
    \/ LReplyReplay \/ LNeverReplay \/ LAdopt \/ LGet \/ LObserveWrite \/ LCrash
    \/ \E s \in Sweeps :
         \/ SCheck(s) \/ SLoad(s) \/ SCheckActive(s) \/ SHoldStopped(s) \/ SDiscover(s)
         \/ SAge(s) \/ SMarkReplay(s) \/ SHoldUnresolved(s) \/ SSendReplay(s) \/ SReplyReplay(s)
         \/ SAdopt(s) \/ SNever(s) \/ SAbort(s)
    \/ CRead \/ CNever \/ CAbort
    \/ RStart \/ RGet \/ RObserveWrite \/ RClaim \/ RDelete \/ RLapse \/ RRecord
    \/ RPoll \/ RAbort \/ RClaimLapses
    \/ \E i \in Inspectors : IGet(i) \/ IObserveWrite(i)

Spec == Init /\ [][Next]_vars

(* What TLC compares states by (VIEW in the cases). An actor's loaded phase and    *)
(* its last Boat read matter only at the steps that read them, and are written    *)
(* before any such step; a request's sender matters only while Boat has yet to    *)
(* act on it. Elsewhere they are left out: states that differ only there behave    *)
(* the same, so the check covers no less, and one worker or many count the same.  *)
PhaseRead == {"discover", "age", "markReplay", "sendReplay", "awaitReplay"}
GotRead   == {"observeWrite", "record"}
View ==
    <<vm, listed, key, snapshot, boatOp, queue, rowVars, envVars, pc, awaiting, inbox,
      [a \in Actors |-> IF pc[a] \in PhaseRead THEN seenPhase[a] ELSE "none"],
      [a \in Actors |-> IF pc[a] \in GotRead THEN got[a] ELSE "none"],
      [i \in 1..MaxSends |-> IF i \in queue THEN from[i] ELSE Launch],
      boundVars>>

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ vm \in {"none", "creating", "created", "deleted"}
    /\ key \in {"free", "linked"}
    /\ snapshot \in {"ready", "gone"}
    /\ boatOp \in {"none", "pending", "completed"}
    /\ queue \subseteq 1..MaxSends
    /\ sandbox \in {"null", "V"}
    /\ held \in {"none", "run-stopped", "create-unresolved"}
    /\ absent \in {"null", "never-created", "not-found", "deletion-completed"}
    /\ coreOp \in {"null", "pending", "completed"}
    /\ status \in {"pending", "ready", "failed", "stopped"}
    /\ stopJob \in {"none", "mark", "done"}
    /\ \A a \in Actors : inbox[a] \in Kinds \cup {"none"}

(* THE PROPERTY. Once Core commits an absence the run leaves every sweep   *)
(* (listUnresolved, listUnsettled), so from then on Boat must hold no VM   *)
(* for it: not now, and not later from a create still on its way.          *)
NoForgottenVM == absent # "null" => vm \in {"none", "deleted"}

=============================================================================
