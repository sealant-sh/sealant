----------------------------- MODULE BoatKeyProof -----------------------------
(***************************************************************************)
(* Promise 2, the full check's ledger.                                     *)
(*                                                                         *)
(* Property: whatever a full check of a Boat key created (a throwaway VM, *)
(* a saved snapshot) is eventually deleted, on every path; and the         *)
(* account's key is never erased or replaced while something the check     *)
(* created may still exist.                                                *)
(* Harm: a saved snapshot holds one of the account's included slots, or    *)
(* bills, for ever; a VM bills until its 15-minute auto-stop and then      *)
(* stays as a stopped sandbox.                                             *)
(*                                                                         *)
(* One stored account, one check of it. Every step is one SQL statement   *)
(* or one HTTP call of the code named beside it; a process may stop        *)
(* between any two.                                                        *)
(*                                                                         *)
(*   key-proof.ts   packages/workspaces/src/runtime/boat/key-proof.ts      *)
(*   proofs.ts      packages/db/src/repositories/boat-key-proofs.ts        *)
(*   accounts.ts    packages/db/src/repositories/boat-accounts.ts          *)
(*   module.ts      apps/api/src/routes/boat-accounts/boat-accounts.module.ts *)
(*   assembly.ts    apps/worker/src/workers/boat-assembly.ts               *)
(*                                                                         *)
(* Boat (docs.boat.dev): any call may be refused or go unanswered, a reply *)
(* may be lost after Boat acted, a request may reach Boat after sealant    *)
(* gave up on it, the label listing may lag a create, a DELETE of a VM     *)
(* stops it at once, and a call with one Boat account's key sees nothing   *)
(* of another's (404, an empty list). Wallets: "A" is the key the account  *)
(* had when the check started; "B" is another Boat account's key that a    *)
(* rotation may store.                                                     *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Sweeps,                 \* workers running sweepBoatKeyProofs at once
    MaxFaults,              \* refusals and lost replies Boat may give in one behaviour
    MaxCrashes,             \* crashes of the check's API process
    MaxAborts,              \* sweep passes that end halfway (a store failure, a worker that dies)
    GetMay404WhileCreating, \* Boat's silence: GET answers 404 for a VM it is still creating
    LateSave,               \* a save may reach Boat after the check gave up on it (and after a delete)
    RotateToOtherAccount,   \* a rotation may store another Boat account's key (no hold to compare)
    \* Schedules that the findings need. FALSE leaves them out (the gate config).
    ClaimMayPassWhileRunning, \* the 15-minute claim passes while the check's process still runs
    OwnerMayRaceCheckStart, \* a removal or rotation commits between the check's account read and its insert
    \* The code under check. BoatKeyProof.cfg has main's values.
    KeyGuardsOnProofs,      \* TRUE on main (sealant#638 round 1): removal and rotation read the ledger
    SweepWaitsForListingLag, \* TRUE on main: an empty label search is trusted only after 10 minutes
    FinishMarksPending,     \* TRUE on main: a cleanup that did not finish sets cleanup_pending
    StartChecksAccount,     \* FALSE on main: `start` reads nothing of the account row
    FenceCheckOnRow,        \* FALSE on main: the check's issue writes and the sweep's settle are
                            \* unguarded; TRUE: they guard on the row (see CCreateIssued, SSettle)
    SnapshotLag             \* FALSE on main: a snapshot DELETE's 404 is "deleted" at once; TRUE:
                            \* only once the save was issued ten minutes ago (as for the VM's list)

(* Main's code. The cases substitute these for the constants of the same name without
   the `Code` prefix; only a case that tests a variant sets its own. *)
CodeKeyGuardsOnProofs       == TRUE   \* rotate, finishRemoval and the routes read the ledger
CodeSweepWaitsForListingLag == TRUE   \* SLocate: "none" counts only once LagPasses
CodeFinishMarksPending      == TRUE   \* finish: cleanup_pending = snapshotLeft or vmLeft

Check   == "check"
Remover == "remover"
Rotator == "rotator"

VARIABLES
    \* Boat
    vm,          \* the check's VM: "none" | "creating" | "running" | "stopped" | "deleted"
    listed,      \* the label listing shows it
    snap,        \* the check's saved snapshot: "none" | "saving" | "ready" | "deleted"
    createAt,    \* a create sent and not yet acted on by Boat: FALSE | TRUE
    saveAt,      \* a save sent and not yet acted on by Boat
    wallet,      \* the wallet the check's client opened: "A" | "B" | "none"
    \* sealant: the account row (accounts.ts) and the check's row in boat_key_proofs (proofs.ts)
    storedKey,   \* boat_accounts.sealed_key: "A" | "B" | "erased"
    removal,     \* removal_requested_at is set
    started, createIssued, sandboxKnown, saveIssued, vmDeleted, snapDeleted,
    finished, cleanupPending,
    claimPassed, \* BOAT_KEY_PROOF_CLAIM_MS (15 min) has passed since the check started
    lagPassed,   \* BOAT_KEY_PROOF_LISTING_LAG_MS (10 min) has passed since the create was issued
    saveLagPassed, \* (SnapshotLag) ten minutes have passed since the save was issued
    \* the check (API process)
    pcC, reply, vmId, vmMayExist, snapMayExist, snapLeft, vmLeft,
    \* the sweeps (worker)
    pcS, rec, swWallet, snapGone, vmGone, swId, aborts,
    \* the remover and the rotator (owner actions through the API, and the worker)
    pcR, pcT, proofsSeen,
    \* bounds
    faults, crashes

boatVars  == <<vm, listed, snap, createAt, saveAt, wallet>>
rowVars   == <<storedKey, removal, started, createIssued, sandboxKnown, saveIssued, vmDeleted,
               snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed>>
checkVars == <<pcC, reply, vmId, vmMayExist, snapMayExist, snapLeft, vmLeft>>
sweepVars == <<pcS, rec, swWallet, snapGone, vmGone, swId, aborts>>
ownerVars == <<pcR, pcT, proofsSeen>>
vars      == <<boatVars, rowVars, checkVars, sweepVars, ownerVars, faults, crashes>>

-----------------------------------------------------------------------------
(* Boat *)

VmExists   == vm \in {"creating", "running", "stopped"}
SnapExists == snap \in {"saving", "ready"}
\* What the check made that Boat holds now. A request still on its way that makes something later
\* makes this true in that later state, which every property below is checked in too.
Holds      == VmExists \/ SnapExists

\* A call made with a key of wallet w sees the check's things only if they are in w.
Sees(w) == w = wallet

\* Boat may refuse or not answer while the fault budget lasts.
Fault == faults < MaxFaults
Faulted == faults' = faults + 1

\* api.get(id)
GetSays(w) ==
    IF ~Sees(w) THEN {"404"}
    ELSE CASE vm \in {"none", "deleted"} -> {"404"}
           [] vm = "creating" -> {"creating"} \cup (IF GetMay404WhileCreating THEN {"404"} ELSE {})
           [] OTHER -> {"present"}

\* findKeyProof(createKey): every page of the label search
ListSays(w) ==
    IF Sees(w) /\ VmExists /\ listed THEN {"found"} ELSE {"none"}

(* Boat acting on its own *)

BoatActsOnCreate ==   \* Boat makes the VM, or refuses; a reply reaches only a check still waiting
    /\ createAt
    /\ createAt' = FALSE
    /\ \/ /\ vm' = "creating"
          /\ \E r \in {"vm"} \cup (IF Fault THEN {"no-answer"} ELSE {}) :
               /\ reply' = IF pcC = "awaitCreate" THEN r ELSE reply
               /\ IF r = "no-answer" THEN Faulted ELSE UNCHANGED faults
       \/ /\ Fault /\ Faulted /\ UNCHANGED vm
          /\ \E r \in {"refused", "no-answer"} :
               reply' = IF pcC = "awaitCreate" THEN r ELSE reply
    /\ UNCHANGED <<listed, snap, saveAt, wallet, rowVars, pcC, vmId, vmMayExist, snapMayExist,
                   snapLeft, vmLeft, sweepVars, ownerVars, crashes>>

BoatActsOnSave ==     \* POST /saved-snapshots from the VM
    /\ saveAt
    /\ saveAt' = FALSE
    /\ \/ /\ vm \in {"running", "stopped"}
          /\ snap' = "saving"
          /\ \E r \in {"saving"} \cup (IF Fault THEN {"no-answer"} ELSE {}) :
               /\ reply' = IF pcC = "awaitSave" THEN r ELSE reply
               /\ IF r = "no-answer" THEN Faulted ELSE UNCHANGED faults
       \/ /\ vm \notin {"running", "stopped"} \/ Fault
          /\ IF vm \notin {"running", "stopped"} THEN UNCHANGED faults ELSE Faulted
          /\ UNCHANGED snap
          /\ \E r \in {"refused", "no-answer"} :
               reply' = IF pcC = "awaitSave" THEN r ELSE reply
    /\ UNCHANGED <<vm, listed, createAt, wallet, rowVars, pcC, vmId, vmMayExist, snapMayExist,
                   snapLeft, vmLeft, sweepVars, ownerVars, crashes>>

VmStarts      == vm = "creating" /\ vm' = "running"
                 /\ UNCHANGED <<listed, snap, createAt, saveAt, wallet, rowVars, checkVars,
                                sweepVars, ownerVars, faults, crashes>>
VmAutoStops   == vm = "running" /\ vm' = "stopped"   \* ttlSeconds 900 is auto-stop, not deletion
                 /\ UNCHANGED <<listed, snap, createAt, saveAt, wallet, rowVars, checkVars,
                                sweepVars, ownerVars, faults, crashes>>
ListingCatchesUp == VmExists /\ ~listed /\ listed' = TRUE
                 /\ UNCHANGED <<vm, snap, createAt, saveAt, wallet, rowVars, checkVars,
                                sweepVars, ownerVars, faults, crashes>>
SnapshotReady == snap = "saving" /\ snap' = "ready"
                 /\ UNCHANGED <<vm, listed, createAt, saveAt, wallet, rowVars, checkVars,
                                sweepVars, ownerVars, faults, crashes>>

(* Time *)

\* Fifteen minutes after the check started. Assumption: no request is still on its way to Boat
\* that long after it was sent (each ends within its 90 s timeout); the check itself may still be
\* running (a stalled process, or a Boat slow enough that every call nears its timeout).
ClaimPasses ==
    /\ started /\ ~finished /\ ~claimPassed /\ ~createAt /\ ~saveAt
    /\ ClaimMayPassWhileRunning \/ pcC = "dead"
    /\ claimPassed' = TRUE
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, snapDeleted, finished, cleanupPending, lagPassed, saveLagPassed, checkVars,
                   sweepVars, ownerVars, faults, crashes>>

\* Ten minutes after create_issued_at. The code's own assumption, kept here: by then the create
\* has been sent (the check does not pause ten minutes between writing create_issued_at and
\* sending), it has reached Boat or never will (a request ends within its 90 s timeout), and Boat's
\* list shows the VM if there is one.
LagPasses ==
    /\ createIssued /\ ~lagPassed /\ ~createAt /\ pcC # "create" /\ (VmExists => listed)
    /\ lagPassed' = TRUE
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, snapDeleted, finished, cleanupPending, claimPassed, saveLagPassed, checkVars,
                   sweepVars, ownerVars, faults, crashes>>

\* (SnapshotLag) Ten minutes after save_issued_at: the save was sent and has reached Boat or never will.
SaveLagPasses ==
    /\ SnapshotLag /\ saveIssued /\ ~saveLagPassed /\ ~saveAt /\ pcC # "save"
    /\ saveLagPassed' = TRUE
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, snapDeleted, finished, cleanupPending, claimPassed, lagPassed,
                   checkVars, sweepVars, ownerVars, faults, crashes>>

\* A snapshot DELETE's answer that the code takes for "gone"
SnapGoneSays == IF SnapshotLag /\ ~saveLagPassed THEN {"deleted"} ELSE {"deleted", "404"}

-----------------------------------------------------------------------------
(* Shared HTTP helpers. Each is one call; `w` is the wallet of the key used. *)

\* deleteSnapshot: done when Boat says deleted or 404. A snapshot still saving answers
\* 409 save_in_progress (delete-saved-snapshot reference): not done.
SnapDeleteSays(w) ==
    IF ~Sees(w) \/ ~SnapExists THEN {"404"}
    ELSE IF snap = "saving" THEN {"conflict"} \cup (IF Fault THEN {"no-answer"} ELSE {})
    ELSE {"deleted"} \cup (IF Fault THEN {"refused", "no-answer", "deleted-lost"} ELSE {})

ApplySnapDelete(w, r) ==
    /\ snap' = IF Sees(w) /\ SnapExists /\ r \in {"deleted", "deleted-lost"} THEN "deleted" ELSE snap
    /\ IF r \in {"refused", "no-answer", "deleted-lost"} THEN Faulted ELSE UNCHANGED faults

\* deleteSandbox: Boat stops and withdraws the VM at once
VmDeleteSays(w) ==
    IF ~Sees(w) \/ ~VmExists THEN {"404"}
    ELSE {"accepted"} \cup (IF Fault THEN {"refused", "no-answer", "accepted-lost"} ELSE {})

ApplyVmDelete(w, r) ==
    /\ vm' = IF Sees(w) /\ VmExists /\ r \in {"accepted", "accepted-lost"} THEN "deleted" ELSE vm
    /\ listed' = IF vm' = "deleted" THEN FALSE ELSE listed
    /\ IF r \in {"refused", "no-answer", "accepted-lost"} THEN Faulted ELSE UNCHANGED faults

-----------------------------------------------------------------------------
(* The check: proveBoatAccount (module.ts) -> proveBoatKey (key-proof.ts), in the API *)

GoC(next) == pcC' = next

\* openStoredAccount + the removal check: the key is opened before the ledger row exists
CRoute ==
    /\ pcC = "route"
    /\ IF storedKey # "erased" /\ ~removal
       THEN GoC("start") /\ wallet' = storedKey
       ELSE GoC("end") /\ UNCHANGED wallet
    /\ UNCHANGED <<vm, listed, snap, createAt, saveAt, rowVars, reply, vmId, vmMayExist,
                   snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* repo.start: INSERT ... ON CONFLICT DO NOTHING (one unfinished check per account).
\* StartChecksAccount (a proposed fix) also refuses an account being removed or re-keyed.
CStart ==
    /\ pcC = "start"
    /\ IF StartChecksAccount /\ (removal \/ storedKey # wallet)
       THEN GoC("end") /\ UNCHANGED started
       ELSE GoC("createIssued") /\ started' = TRUE
    /\ UNCHANGED <<boatVars, storedKey, removal, createIssued, sandboxKnown, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* repo.createIssued: written before the create is sent (an unguarded UPDATE on main).
\* FenceCheckOnRow (a proposed fix): WHERE finished_at IS NULL, and the check stops if it hit no row.
CCreateIssued ==
    /\ pcC = "createIssued"
    /\ IF FenceCheckOnRow /\ finished
       THEN GoC("finally") /\ UNCHANGED <<createIssued, vmMayExist>>
       ELSE createIssued' = TRUE /\ vmMayExist' = TRUE /\ GoC("create")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, sandboxKnown, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* client.create(...): the only create under its key
CCreate ==
    /\ pcC = "create"
    /\ createAt' = TRUE /\ reply' = "none" /\ GoC("awaitCreate")
    /\ UNCHANGED <<vm, listed, snap, saveAt, wallet, rowVars, vmId, vmMayExist, snapMayExist,
                   snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* the create's answer: the VM, a refusal of Boat's own (`definiteRefusal`), or none
CAwaitCreate ==
    /\ pcC = "awaitCreate"
    /\ LET r == IF reply = "none" THEN "no-answer" ELSE reply IN   \* the call may end unanswered
         CASE r = "vm"      -> GoC("sandboxSeen") /\ vmId' = TRUE /\ UNCHANGED vmMayExist
           [] r = "refused" -> GoC("finally") /\ vmMayExist' = FALSE /\ UNCHANGED vmId
           [] OTHER         -> GoC("finally") /\ UNCHANGED <<vmMayExist, vmId>>
    /\ reply' = "none"
    /\ UNCHANGED <<boatVars, rowVars, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars,
                   faults, crashes>>

\* repo.sandboxSeen
CSandboxSeen ==
    /\ pcC = "sandboxSeen"
    /\ sandboxKnown' = TRUE /\ GoC("use")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* wait for the VM to start, run `true`, publish the port: each may fail and end the body
CUse ==
    /\ pcC = "use"
    /\ \/ vm = "running" /\ GoC("saveIssued") /\ UNCHANGED faults
       \/ Fault /\ Faulted /\ GoC("finally")
       \/ vm # "running" /\ vm # "creating" /\ GoC("finally") /\ UNCHANGED faults
    /\ UNCHANGED <<boatVars, rowVars, reply, vmId, vmMayExist, snapMayExist, snapLeft, vmLeft,
                   sweepVars, ownerVars, crashes>>

\* repo.saveIssued: written before the save is sent (an unguarded UPDATE on main; see CCreateIssued)
CSaveIssued ==
    /\ pcC = "saveIssued"
    /\ IF FenceCheckOnRow /\ finished
       THEN GoC("finally") /\ UNCHANGED <<saveIssued, snapMayExist>>
       ELSE saveIssued' = TRUE /\ snapMayExist' = TRUE /\ GoC("save")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* client.saveSnapshot(vm, name)
CSave ==
    /\ pcC = "save"
    /\ saveAt' = TRUE /\ reply' = "none" /\ GoC("awaitSave")
    /\ UNCHANGED <<vm, listed, snap, createAt, wallet, rowVars, vmId, vmMayExist, snapMayExist,
                   snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* the save's answer, then its wait for `ready`; every outcome goes on to the cleanup
CAwaitSave ==
    /\ pcC = "awaitSave"
    /\ \/ reply # "none"
       \/ reply = "none" /\ LateSave        \* the call ends unanswered; Boat may act on it later
       \/ reply = "none" /\ ~saveAt         \* Boat acted and the reply was lost
    /\ reply' = "none" /\ GoC("finally")
    /\ UNCHANGED <<boatVars, rowVars, vmId, vmMayExist, snapMayExist, snapLeft, vmLeft,
                   sweepVars, ownerVars, faults, crashes>>

\* finally: deleteSnapshot(client, name) when the save was issued
CDeleteSnapshot ==
    /\ pcC = "finally"
    /\ IF snapMayExist
       THEN \E r \in SnapDeleteSays(wallet) :
              /\ ApplySnapDelete(wallet, r)
              /\ IF r \in SnapGoneSays
                 THEN GoC("snapshotDeleted") /\ UNCHANGED snapLeft
                 ELSE GoC("vm") /\ snapLeft' = TRUE
       ELSE GoC("vm") /\ UNCHANGED <<snap, snapLeft, faults>>
    /\ UNCHANGED <<vm, listed, createAt, saveAt, wallet, rowVars, reply, vmId, vmMayExist,
                   snapMayExist, vmLeft, sweepVars, ownerVars, crashes>>

\* repo.snapshotDeleted
CSnapshotDeleted ==
    /\ pcC = "snapshotDeleted"
    /\ snapDeleted' = TRUE /\ GoC("vm")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* finally: the VM, by its id or found by its label (locateVm)
CVm ==
    /\ pcC = "vm"
    /\ CASE ~vmMayExist -> GoC("finish") /\ UNCHANGED <<vmId, vmLeft>>
         [] vmId        -> GoC("deleteVm") /\ UNCHANGED <<vmId, vmLeft>>
         [] OTHER ->
              \/ "found" \in ListSays(wallet) /\ GoC("seenFound") /\ vmId' = TRUE
                 /\ UNCHANGED vmLeft
              \/ GoC("finish") /\ vmLeft' = TRUE /\ UNCHANGED vmId   \* none yet, or no answer
    /\ UNCHANGED <<boatVars, rowVars, reply, vmMayExist, snapMayExist, snapLeft, sweepVars,
                   ownerVars, faults, crashes>>

CSeenFound ==   \* repo.sandboxSeen for a VM found by its label
    /\ pcC = "seenFound"
    /\ sandboxKnown' = TRUE /\ GoC("deleteVm")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* deleteVm: DELETE (a refusal other than 404 stops here), then GET until 404
CDeleteVm ==
    /\ pcC = "deleteVm"
    /\ \E r \in VmDeleteSays(wallet) :
         /\ ApplyVmDelete(wallet, r)
         /\ IF r = "refused" THEN GoC("finish") /\ vmLeft' = TRUE
                             ELSE GoC("pollVm") /\ UNCHANGED vmLeft
    /\ UNCHANGED <<snap, createAt, saveAt, wallet, rowVars, reply, vmId, vmMayExist, snapMayExist,
                   snapLeft, sweepVars, ownerVars, crashes>>

CPollVm ==
    /\ pcC = "pollVm"
    /\ \/ "404" \in GetSays(wallet) /\ GoC("vmDeleted") /\ UNCHANGED vmLeft
       \/ GoC("finish") /\ vmLeft' = TRUE        \* the wait ran out
    /\ UNCHANGED <<boatVars, rowVars, reply, vmId, vmMayExist, snapMayExist, snapLeft,
                   sweepVars, ownerVars, faults, crashes>>

CVmDeleted ==   \* repo.vmDeleted
    /\ pcC = "vmDeleted"
    /\ vmDeleted' = TRUE /\ GoC("finish")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, reply, vmId,
                   vmMayExist, snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* repo.finish: UPDATE ... WHERE finished_at IS NULL. A row the sweep settled keeps its result.
CFinish ==
    /\ pcC = "finish"
    /\ IF ~finished
       THEN finished' = TRUE /\ cleanupPending' = (FinishMarksPending /\ (snapLeft \/ vmLeft))
       ELSE UNCHANGED <<finished, cleanupPending>>
    /\ GoC("end")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, snapDeleted, claimPassed, lagPassed, saveLagPassed, reply, vmId, vmMayExist,
                   snapMayExist, snapLeft, vmLeft, sweepVars, ownerVars, faults, crashes>>

\* The API process dies between two steps. Its requests may still reach Boat.
CCrash ==
    /\ pcC \notin {"route", "end", "dead"}
    /\ crashes < MaxCrashes /\ crashes' = crashes + 1
    /\ GoC("dead")
    /\ UNCHANGED <<boatVars, rowVars, reply, vmId, vmMayExist, snapMayExist, snapLeft, vmLeft,
                   sweepVars, ownerVars, faults>>

-----------------------------------------------------------------------------
(* The sweep: sweepBoatKeyProofs (key-proof.ts), from assembly.ts `sweepKeyProofs` *)

GoS(s, next) == pcS' = [pcS EXCEPT ![s] = next]
Unchanged4S  == UNCHANGED <<boatVars, rowVars, checkVars, ownerVars, faults, crashes, aborts>>

\* repo.toSweep(now): the row as it is now, copied (the rest of the pass reads this copy)
SPick(s) ==
    /\ pcS[s] = "idle"
    /\ started /\ ((~finished /\ claimPassed) \/ cleanupPending)
    /\ rec' = [rec EXCEPT ![s] = [createIssued |-> createIssued, sandboxKnown |-> sandboxKnown,
                                  saveIssued |-> saveIssued, vmDeleted |-> vmDeleted,
                                  snapDeleted |-> snapDeleted]]
    /\ GoS(s, "client")
    /\ UNCHANGED <<swWallet, snapGone, vmGone, swId>>
    /\ Unchanged4S

\* clientFor(account): openStoredBoatKey reads the account's key now; none once it is erased
SClient(s) ==
    /\ pcS[s] = "client"
    /\ IF storedKey = "erased"
       THEN GoS(s, "idle") /\ UNCHANGED swWallet
       ELSE GoS(s, "snapshot") /\ swWallet' = [swWallet EXCEPT ![s] = storedKey]
    /\ UNCHANGED <<rec, snapGone, vmGone, swId>>
    /\ Unchanged4S

\* deleteSnapshot by name, unless the copy says none was issued or it is deleted
SSnapshot(s) ==
    /\ pcS[s] = "snapshot"
    /\ IF ~rec[s].saveIssued \/ rec[s].snapDeleted
       THEN /\ snapGone' = [snapGone EXCEPT ![s] = TRUE] /\ GoS(s, "locate")
            /\ UNCHANGED <<snap, faults>>
       ELSE \E r \in SnapDeleteSays(swWallet[s]) :
              /\ ApplySnapDelete(swWallet[s], r)
              /\ IF r \in SnapGoneSays
                 THEN GoS(s, "snapshotDeleted") /\ snapGone' = [snapGone EXCEPT ![s] = TRUE]
                 ELSE GoS(s, "locate") /\ snapGone' = [snapGone EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<vm, listed, createAt, saveAt, wallet, rowVars, checkVars, ownerVars, crashes, aborts,
                   rec, swWallet, vmGone, swId>>

SSnapshotDeleted(s) ==   \* repo.snapshotDeleted
    /\ pcS[s] = "snapshotDeleted"
    /\ snapDeleted' = TRUE /\ GoS(s, "locate")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   ownerVars, faults, crashes, aborts, rec, swWallet, snapGone, vmGone, swId>>

\* locateVm: the id on the copy, or the label search; none counts only once the lag has passed
SLocate(s) ==
    /\ pcS[s] = "locate"
    /\ CASE ~rec[s].createIssued \/ rec[s].vmDeleted ->
              /\ GoS(s, "settle") /\ vmGone' = [vmGone EXCEPT ![s] = TRUE]
              /\ UNCHANGED <<swId, faults>>
         [] rec[s].sandboxKnown ->
              /\ GoS(s, "deleteVm") /\ swId' = [swId EXCEPT ![s] = TRUE]
              /\ UNCHANGED <<vmGone, faults>>
         [] OTHER ->
              \E l \in ListSays(swWallet[s]) \cup (IF Fault THEN {"unknown"} ELSE {}) :
                /\ faults' = IF l = "unknown" THEN faults + 1 ELSE faults
                /\ CASE l = "found" ->
                          GoS(s, "seenFound") /\ swId' = [swId EXCEPT ![s] = TRUE] /\ UNCHANGED vmGone
                     [] l = "none" /\ (lagPassed \/ ~SweepWaitsForListingLag) ->
                          GoS(s, "vmDeleted") /\ vmGone' = [vmGone EXCEPT ![s] = TRUE]
                          /\ UNCHANGED swId
                     [] OTHER ->   \* none before the lag has passed, or Boat did not answer
                          GoS(s, "settle") /\ vmGone' = [vmGone EXCEPT ![s] = FALSE]
                          /\ UNCHANGED swId
    /\ UNCHANGED <<boatVars, rowVars, checkVars, ownerVars, crashes, aborts, rec, swWallet, snapGone>>

SSeenFound(s) ==   \* repo.sandboxSeen
    /\ pcS[s] = "seenFound"
    /\ sandboxKnown' = TRUE /\ GoS(s, "deleteVm")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   ownerVars, faults, crashes, aborts, rec, swWallet, snapGone, vmGone, swId>>

\* deleteVm: DELETE, then GET until 404 (or the wait runs out)
SDeleteVm(s) ==
    /\ pcS[s] = "deleteVm"
    /\ \E r \in VmDeleteSays(swWallet[s]) :
         /\ ApplyVmDelete(swWallet[s], r)
         /\ GoS(s, IF r = "refused" THEN "settle" ELSE "pollVm")
         /\ vmGone' = IF r = "refused" THEN [vmGone EXCEPT ![s] = FALSE] ELSE vmGone
    /\ UNCHANGED <<snap, createAt, saveAt, wallet, rowVars, checkVars, ownerVars, crashes, aborts,
                   rec, swWallet, snapGone, swId>>

SPollVm(s) ==
    /\ pcS[s] = "pollVm"
    /\ LET gone == "404" \in GetSays(swWallet[s]) IN
         \/ /\ gone
            /\ GoS(s, "vmDeleted")
            /\ vmGone' = [vmGone EXCEPT ![s] = TRUE]
            /\ UNCHANGED faults
         \/ /\ ~gone \/ Fault                  \* the wait runs out
            /\ faults' = IF gone THEN faults + 1 ELSE faults
            /\ GoS(s, "settle")
            /\ vmGone' = [vmGone EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<boatVars, rowVars, checkVars, ownerVars, crashes, aborts, rec, swWallet,
                   snapGone, swId>>

SVmDeleted(s) ==   \* repo.vmDeleted
    /\ pcS[s] = "vmDeleted"
    /\ vmDeleted' = TRUE /\ GoS(s, "settle")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   ownerVars, faults, crashes, aborts, rec, swWallet, snapGone, vmGone, swId>>

\* repo.settle: cleanup_pending = false, finished_at = coalesce(finished_at, now). An unguarded
\* UPDATE on main; with FenceCheckOnRow it also requires create_issued_at and save_issued_at to be
\* as the pass's copy read them.
SSettle(s) ==
    /\ pcS[s] = "settle"
    /\ IF /\ snapGone[s] /\ vmGone[s]
          /\ FenceCheckOnRow => (rec[s].createIssued = createIssued /\ rec[s].saveIssued = saveIssued)
       THEN cleanupPending' = FALSE /\ finished' = TRUE
       ELSE UNCHANGED <<cleanupPending, finished>>
    /\ GoS(s, "idle")
    /\ UNCHANGED <<boatVars, storedKey, removal, started, createIssued, sandboxKnown, saveIssued,
                   vmDeleted, snapDeleted, claimPassed, lagPassed, saveLagPassed, checkVars, ownerVars,
                   faults, crashes, aborts, rec, swWallet, snapGone, vmGone, swId>>

\* A pass that throws (a store failure) or a worker that dies ends here; the next pass starts over.
SAbort(s) ==
    /\ pcS[s] # "idle"
    /\ aborts < MaxAborts /\ aborts' = aborts + 1
    /\ GoS(s, "idle")
    /\ UNCHANGED <<boatVars, rowVars, checkVars, ownerVars, faults, crashes, rec, swWallet,
                   snapGone, vmGone, swId>>

-----------------------------------------------------------------------------
(* The owner removes the account (removeBoatAccount, module.ts) and the worker finishes it  *)
(* (reconcileRemovals, assembly.ts). The account holds no runs or images in this model.     *)

Outstanding == started /\ (~finished \/ cleanupPending)   \* proofs.ts `outstanding`
\* What the owner's routes and the worker's removal read of the ledger.
ProofsHeld  == KeyGuardsOnProofs /\ Outstanding
\* Without OwnerMayRaceCheckStart nothing of the owner's commits while the check is between its
\* account read and its insert.
OwnerMayCommit == OwnerMayRaceCheckStart \/ pcC # "start"

\* proofLeftovers: BoatKeyProofRepo.outstanding, read before requestRemoval
RLeftovers ==
    /\ pcR = "idle" /\ ~removal /\ storedKey # "erased"
    /\ pcR' = IF ProofsHeld THEN "idle" ELSE "request"
    /\ UNCHANGED <<boatVars, rowVars, checkVars, sweepVars, pcT, proofsSeen, faults, crashes>>

\* requestRemoval: one transaction on the account row (runs and builds counted, none here)
RRequest ==
    /\ pcR = "request" /\ OwnerMayCommit
    /\ removal' = TRUE /\ pcR' = "count"
    /\ UNCHANGED <<boatVars, storedKey, started, createIssued, sandboxKnown, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   sweepVars, pcT, proofsSeen, faults, crashes>>

\* finishRemoval: SELECT count(*) FROM boat_key_proofs WHERE unfinished or cleanup_pending ...
RCount ==
    /\ pcR = "count"
    /\ proofsSeen' = ProofsHeld /\ pcR' = "erase"
    /\ UNCHANGED <<boatVars, rowVars, checkVars, sweepVars, pcT, faults, crashes>>

\* ... then, in the same transaction, UPDATE boat_accounts SET sealed_key = null (if none seen)
RErase ==
    /\ pcR = "erase" /\ OwnerMayCommit
    /\ IF proofsSeen THEN pcR' = "count" /\ UNCHANGED storedKey   \* held: tried again next pass
                     ELSE pcR' = "done" /\ storedKey' = "erased"
    /\ UNCHANGED <<boatVars, removal, started, createIssued, sandboxKnown, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   sweepVars, pcT, proofsSeen, faults, crashes>>

\* The owner rotates the key (rotateBoatAccountKey, module.ts): proofLeftovers, Boat's checks of
\* the new key, then accounts.ts `rotate`, whose WHERE has NOT EXISTS (outstanding proofs).
TLeftovers ==
    /\ pcT = "idle" /\ ~removal /\ storedKey = "A"
    /\ pcT' = IF ProofsHeld THEN "idle" ELSE "rotate"
    /\ UNCHANGED <<boatVars, rowVars, checkVars, sweepVars, pcR, proofsSeen, faults, crashes>>

TRotate ==
    /\ pcT = "rotate" /\ OwnerMayCommit
    /\ IF ~removal /\ ~ProofsHeld /\ storedKey # "erased"
       THEN storedKey' = (IF RotateToOtherAccount THEN "B" ELSE "A")
       ELSE UNCHANGED storedKey
    /\ pcT' = "done"
    /\ UNCHANGED <<boatVars, removal, started, createIssued, sandboxKnown, saveIssued, vmDeleted,
                   snapDeleted, finished, cleanupPending, claimPassed, lagPassed, saveLagPassed, checkVars,
                   sweepVars, pcR, proofsSeen, faults, crashes>>

-----------------------------------------------------------------------------

Init ==
    /\ vm = "none" /\ listed = FALSE /\ snap = "none" /\ createAt = FALSE /\ saveAt = FALSE
    /\ wallet = "none"
    /\ storedKey = "A" /\ removal = FALSE
    /\ started = FALSE /\ createIssued = FALSE /\ sandboxKnown = FALSE /\ saveIssued = FALSE
    /\ vmDeleted = FALSE /\ snapDeleted = FALSE /\ finished = FALSE /\ cleanupPending = FALSE
    /\ claimPassed = FALSE /\ lagPassed = FALSE /\ saveLagPassed = FALSE
    /\ pcC = "route" /\ reply = "none" /\ vmId = FALSE /\ vmMayExist = FALSE
    /\ snapMayExist = FALSE /\ snapLeft = FALSE /\ vmLeft = FALSE
    /\ pcS = [s \in Sweeps |-> "idle"]
    /\ rec = [s \in Sweeps |-> [createIssued |-> FALSE, sandboxKnown |-> FALSE,
                                saveIssued |-> FALSE, vmDeleted |-> FALSE, snapDeleted |-> FALSE]]
    /\ swWallet = [s \in Sweeps |-> "none"]
    /\ snapGone = [s \in Sweeps |-> FALSE]
    /\ vmGone = [s \in Sweeps |-> FALSE]
    /\ swId = [s \in Sweeps |-> FALSE]
    /\ aborts = 0
    /\ pcR = "idle" /\ pcT = "idle" /\ proofsSeen = FALSE
    /\ faults = 0 /\ crashes = 0

CheckStep ==
    \/ CRoute \/ CStart \/ CCreateIssued \/ CCreate \/ CAwaitCreate \/ CSandboxSeen \/ CUse
    \/ CSaveIssued \/ CSave \/ CAwaitSave \/ CDeleteSnapshot \/ CSnapshotDeleted \/ CVm
    \/ CSeenFound \/ CDeleteVm \/ CPollVm \/ CVmDeleted \/ CFinish

SweepStep(s) ==
    \/ SPick(s) \/ SClient(s) \/ SSnapshot(s) \/ SSnapshotDeleted(s) \/ SLocate(s)
    \/ SSeenFound(s) \/ SDeleteVm(s) \/ SPollVm(s) \/ SVmDeleted(s) \/ SSettle(s)

BoatStep ==
    \/ BoatActsOnCreate \/ BoatActsOnSave \/ VmStarts \/ ListingCatchesUp \/ SnapshotReady

Next ==
    \/ CheckStep \/ CCrash
    \/ \E s \in Sweeps : SweepStep(s) \/ SAbort(s)
    \/ BoatStep \/ VmAutoStops \/ ClaimPasses \/ LagPasses \/ SaveLagPasses
    \/ RLeftovers \/ RRequest \/ RCount \/ RErase \/ TLeftovers \/ TRotate

\* Fairness for the liveness check: the check and each sweep keep taking steps, Boat keeps acting,
\* and time passes. The owner's removal and rotation need none: they may happen or not.
Fairness ==
    /\ WF_vars(CheckStep)
    /\ \A s \in Sweeps : WF_vars(SweepStep(s))
    /\ WF_vars(BoatStep)
    /\ WF_vars(ClaimPasses) /\ WF_vars(LagPasses) /\ WF_vars(SaveLagPasses)

Spec     == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* The check's row no longer asks anyone to delete anything: not in toSweep, not outstanding.
Settled == started /\ finished /\ ~cleanupPending

\* 1. Once the ledger is settled and no check process holds anything in memory (it ended, or
\*    died), Boat holds nothing of the check: nothing will ever delete it.
NothingLeftWhenSettled == (Settled /\ pcC \in {"end", "dead"}) => ~Holds

\* 2. The key that made the check's things stays until they are gone.
KeyKeptWhileLeftover == (wallet # "none" /\ storedKey # wallet) => ~Holds

\* 3. Eventually Boat holds nothing of the check (VM deleted, not merely stopped; snapshot deleted).
EventuallyDeleted == <>[](~Holds /\ ~createAt /\ ~saveAt)

=============================================================================
