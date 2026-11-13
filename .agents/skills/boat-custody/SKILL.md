---
name: boat-custody
description:
  Model-check Boat custody (TLA+): sealant never forgets a Boat VM that may exist, and a full check
  of a Boat key leaves nothing behind. Use when a change touches Boat run creation, discovery,
  replay, observation or deletion (vm.ts, removal.ts, convergence.ts, boat_runs), the full check
  (key-proof.ts, boat_key_proofs), or a Boat account's rotation or removal; or to rerun or update
  these models.
---

# Boat custody

Two TLA+ models in `docs/verification/boat-custody/` hold sealant to two promises:

- **Run ledger** (`BoatRunLedger.tla`, invariant `NoForgottenVM`): sealant never records a run as
  absent, and so never stops tracking it, while Boat may hold a VM for it.
- **Full check** (`BoatKeyProof.tla`, `NothingLeftWhenSettled`, `KeyKeptWhileLeftover`,
  `EventuallyDeleted`): what a full check made is eventually deleted, and the account keeps the key
  that made it until then.

Each step of a model is one SQL statement or one HTTP call of the code, named in the comment above
it; Boat is an adversary bounded by its docs. The record of what is verified, the bounds, the
assumptions, Boat's silences and the open findings is `docs/verification/boat-custody/README.md`.
Read it before you judge a counterexample.

**Sync commit: `dd39b9de`.** The models were last confirmed to describe the code there.
sealant#648's change since (`markReplay` and `recordFirstCreateRefused`, the fix of P1-A) is
mirrored in `BoatRunLedger.tla`. The hunks sealant#641 made in the covered files (each object's
wallet, the `unreachable` absence) are not yet read against the models: read them before you move
this commit.

## 1. Does the change touch it?

List what changed in the covered files since the sync commit, the working tree included:

```bash
git diff --stat dd39b9de -- \
  packages/workspaces/src/runtime/boat/{vm,api,failure,removal,convergence,adapter,key-proof,accounts}.ts \
  packages/db/src/repositories/boat-{runs,key-proofs,accounts}.ts \
  packages/db/src/repositories/workspace-runtime-instances.ts \
  packages/validators/src/workspaces/boat-run.ts \
  packages/workspaces/src/worker/process-workspace-{build-job,stop}.ts \
  apps/worker/src/workers/boat-assembly.ts \
  apps/api/src/routes/boat-accounts/boat-accounts.module.ts
```

Empty: the models still describe the code; run step 3 if you want the evidence, and stop. Otherwise
read each changed hunk against the coverage record below. A hunk that changes what a covered
function does (a guard, the order of two statements or calls, which Boat answers lead where, a new
writer of a covered column) goes to step 2. A hunk that leaves every covered function's behaviour as
it was (logging, types, a new unrelated sweep) needs no model change: note it for step 5.

## 2. Mirror the change in the model

The model does not read TypeScript: a change is checked only once the model says what the code now
says. For each behavioural hunk, find its action in the coverage record and change the action the
same way:

- A `WHERE` clause is a guard operator (`IssueGuard`, `AdoptGuard`, `HoldGuard`,
  `RecordNeverCreated`, `RecordNotFound`, `RecordDeletion`; in the full check, the `IF` in the
  step).
- A new statement or HTTP call is a new step with its own `pc` value, so a crash and every other
  actor can fall between it and its neighbours. Two statements in one transaction are one step only
  if no other writer can commit between them.
- Main's choices live once, in the `Code…` definitions near the top of each model:
  `CodeFirstCreateRejected` and `CodeReplayRejected` are `firstCreateRejected` and `replayRejected`
  as sets of the model's kinds (the comment above `Kinds` maps each `BoatFailureKind` to one);
  `CodeMarkReplayBeforeSend` is `markReplay` before every replay with `recordFirstCreateRefused`;
  `CodeKeyGuardsOnProofs`, `CodeSweepWaitsForListingLag` and `CodeFinishMarksPending` are the full
  check's guards. The cases substitute them (`<-`); edit the definition, not the cases. Only
  `*-broken-*` and `*-fixes*` cases set their own values.
- A change to what Boat may do needs a citation from docs.boat.dev. Where the docs are silent, add a
  constant that lets the adversary do either, with a case for each value.

Every action must say what happens to every variable: list the ones it leaves alone in `UNCHANGED`.
`BoatRunLedger.tla` compares states by `View`, which leaves out an actor's `seenPhase` and `got`
except at the steps in `PhaseRead` and `GotRead`: a new step that reads either belongs in that set,
or TLC can skip behaviours. (One worker and many give the same state count when the view is right.)
If the change fixes an open finding, switch its fix on in the model, set the finding's case to
`expect: pass`, and keep a case that fails without the fix.

## 3. Run the check

```bash
docs/verification/boat-custody/check.sh
```

About three minutes on 32 cores (15 cases). Done when the last line is
`Every case gave its expected verdict.` and the exit status is 0. `--deep` adds five longer cases
(about 40 minutes on 32 cores): run it before merging a change from step 2. `--trace` also prints
the counterexample of the cases that are meant to fail. Name cases to run only those
(`check.sh ledger proof`).

The checker is TLC 2.19 (TLA+ tools 1.7.4) from the nixpkgs this repository's `flake.lock` pins; the
script builds it with `nix` the first time. Without Nix, set `TLA2TOOLS_JAR` to `tla2tools.jar`
v1.7.4 (github.com/tlaplus/tlaplus/releases) and have Java 11 or later, or put a `tlc` on `PATH`.
Node prints the counterexamples (`trace.mjs`).

Each file in `cases/` states its module, the verdict it must give (`expect: pass`, an invariant's
name, or `temporal`) and its group. `ledger` and `proof` (`proof-live` for liveness) are main's code
under main's own assumptions; `*-finding-*` reproduce the open findings; `*-broken-*` are broken
variants that must fail; `*-fixes*` turn every schedule and the proposed fixes on.

## 4. Read the result

A `FAIL` line prints the counterexample, one line per step: the action, then the variables it
changed. Read each step in the code its action names, and decide:

- **Modelling error**: the trace takes a step the code cannot take in that state: a guard the code
  has and the model lacks, two statements the model runs in an order the code never does, or a Boat
  answer the docs rule out. Fix the model to match the code and run again.
- **Timing the code relies on**: the trace needs a request to reach Boat long after its 90 s
  timeout, or a process to pause between a ledger write and the call it guards for longer than the
  code's own lag. Encode the assumption as the guard of the time event (`LagPasses`, `ClaimPasses`,
  `LeaseLapses`) and add it to the record's assumptions.
- **Real break**: every step is one the code and Boat can take. Do not weaken the property, the
  bounds or Boat. Tell the counterexample as a short list of steps in the code's words, say which of
  Boat's silences it needs, how likely the schedule is and what it costs, add a `*-finding-*` case,
  and report it in the record and to whoever asked for the change.
- `got error` is a broken model, not a verdict: usually an action that leaves a variable unassigned
  (`not completely specified`) or a parse error at the line shown.

An unexpected `pass` on a `*-finding-*` or `*-broken-*` case means the model no longer reaches that
schedule: find out why before you flip its expectation.

## 5. Record it

Once the models describe the code at your commit and `check.sh` (and `--deep`) give their expected
verdicts: update the coverage record below and the record's findings, then move the sync commit, in
this file and in the record, to that commit. Move it only after reading every covered hunk since the
old one.

## Coverage record

Files as named in step 1's list. Run ledger, `BoatRunLedger.tla`:

| Code                                                                                                                                                                                                                           | Model                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vm.ts` `resolve`: load, phase, `isActive`, hold `run-stopped`                                                                                                                                                                 | `LLoad`, `LHoldStopped`; `SLoad`, `SCheckActive`, `SHoldStopped`                                                                                                                                          |
| `vm.ts` `resolve`, reserved: `getSnapshot`, `issueCreate`, the first create, `firstCreateRejected`, `recordFirstCreateRefused`                                                                                                 | `LReadSource`, `LIssue`, `LSendFirst`, `LReplyFirst`, `LNeverFirst`; `FirstCreateRejectedKinds`, `FirstRefusalRecords`                                                                                    |
| `vm.ts` `resolve`, issued: `discover`, `createAgeMs` against `BOAT_CREATE_REPLAY_WINDOW_MS`, hold `create-unresolved`, `markReplay`, the replay, `replayRejected`, `adopt`                                                     | `LDiscover`, `LAge`, `LHoldUnresolved`, `LMarkReplay`, `LSendReplay`, `LReplyReplay`, `LNeverReplay`, `LAdopt`; the `S…` steps of the same names; `ReplayRejectedKinds`, `MarkReplayBeforeSend`, `window` |
| `vm.ts` `DEFINITE_REFUSALS`; `failure.ts` `kindByCode`                                                                                                                                                                         | `Kinds` (comment), `CreateAnswers`                                                                                                                                                                        |
| `vm.ts` `observe`; `adapter.ts` `inspect`, `recover`                                                                                                                                                                           | `LGet`/`LObserveWrite`, `RGet`/`RObserveWrite`, `IGet`/`IObserveWrite`, `ObservedGet`                                                                                                                     |
| `vm.ts` `prepared` (retries), `reconcile` (`launchInFlight`)                                                                                                                                                                   | `LaunchRetry`, `MaxRetries`; `SCheck`                                                                                                                                                                     |
| `boat-runs.ts` `issueCreate`, `adopt`, `hold`, `seen`, `recordNotFound`, `recordNeverCreated`, `recordFirstCreateRefused`, `markReplay`, `claimDeletion`, `lapseDeletionClaim`, `recordDeletion`, `isActive`, `launchInFlight` | `IssueGuard`, `AdoptGuard`, `HoldGuard`, `Seen`, `RecordNotFound`, `RecordNeverCreated`, `RecordNeverCreatedFirst`, `MarkReplayGuard`, `RClaim`, `RLapse`, `RecordDeletion`, `Active`, `LaunchInFlight`   |
| `packages/validators/src/workspaces/boat-run.ts` `boatRunVmPhase`                                                                                                                                                              | `Phase`                                                                                                                                                                                                   |
| `removal.ts` `deletion`: observe, `stopping`, `claimDeletion`, `DELETE`, `follow`/`record`, the operation poll, `BOAT_REMOVAL_CLAIM_MS`                                                                                        | `RStart`, `RGet`, `RObserveWrite`, `RClaim`, `RDelete`, `RLapse`, `RRecord`, `RPoll`, `RClaimLapses`                                                                                                      |
| `convergence.ts` `step`, a run with no VM held `run-stopped`                                                                                                                                                                   | `CRead`, `CNever`                                                                                                                                                                                         |
| `process-workspace-build-job.ts` launch lease (`DEFAULT_LAUNCH_LEASE_MS`, `renewLaunchLease`); `workspace-runtime-instances.ts`                                                                                                | `lease`, `LeaseLapses`                                                                                                                                                                                    |
| `process-workspace-stop.ts` `processWorkspaceStop`: a run with no VM on record is `markStopped`; the stop route's `markStopRequested`                                                                                          | `StopAsked`, `StopJobReads`, `StopJobMarksStopped`                                                                                                                                                        |
| `api.ts` `create` (`Idempotency-Key`), `discover`, `get`, `deleteSandbox`                                                                                                                                                      | `Send`, `BoatActsOnCreate`, `ListResults`, `GetResults`, `RDelete`                                                                                                                                        |

Full check, `BoatKeyProof.tla`:

| Code                                                                                                                                                                                            | Model                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `boat-accounts.module.ts` `proveBoatAccount` (`openStoredAccount`, the removal check)                                                                                                           | `CRoute`                                                                                                                                |
| `key-proof.ts` `proveBoatKey`: `start`, `createIssued`, `create`, `definiteRefusal`, `sandboxSeen`, the start wait, `execute`, `hostControl`, `saveIssued`, `saveSnapshot` and its wait         | `CStart`, `CCreateIssued`, `CCreate`, `CAwaitCreate`, `CSandboxSeen`, `CUse`, `CSaveIssued`, `CSave`, `CAwaitSave`                      |
| `key-proof.ts` the `finally` block: `deleteSnapshot`, `locateVm`, `deleteVm`, `finish`                                                                                                          | `CDeleteSnapshot`, `CSnapshotDeleted`, `CVm`, `CSeenFound`, `CDeleteVm`, `CPollVm`, `CVmDeleted`, `CFinish`                             |
| `key-proof.ts` `sweepBoatKeyProofs`; `boat-assembly.ts` `sweepKeyProofs` (`clientFor`)                                                                                                          | `SPick`, `SClient`, `SSnapshot`, `SSnapshotDeleted`, `SLocate`, `SSeenFound`, `SDeleteVm`, `SPollVm`, `SVmDeleted`, `SSettle`, `SAbort` |
| `key-proof.ts` `BOAT_KEY_PROOF_CLAIM_MS`, `BOAT_KEY_PROOF_LISTING_LAG_MS`                                                                                                                       | `ClaimPasses`, `LagPasses`                                                                                                              |
| `boat-key-proofs.ts` `start`, `finish`, `toSweep`, `settle`, `outstanding`                                                                                                                      | `CStart`, `CFinish`, `SPick`, `SSettle`, `Outstanding`                                                                                  |
| `boat-accounts.module.ts` `proofLeftovers`, `rotateBoatAccountKey`, `removeBoatAccount`; `boat-accounts.ts` `rotate`, `requestRemoval`, `finishRemoval`; `boat-assembly.ts` `reconcileRemovals` | `TLeftovers`, `TRotate`; `RLeftovers`, `RRequest`, `RCount`, `RErase`; `ProofsHeld`                                                     |
| `api.ts` `findKeyProof`, `get`, `deleteSandbox`, `deleteSnapshot` (409 while saving), `saveSnapshot`                                                                                            | `ListSays`, `GetSays`, `VmDeleteSays`, `SnapDeleteSays`, `BoatActsOnSave`                                                               |

## Open findings

Each has a case that is expected to fail until the code and the model change; the record tells each
one in full, with its likelihood and a proposed fix the model accepts. P1-A is fixed (sealant#648,
SLNT-825): its case `ledger-finding-replay-during-first-create` passes, and
`ledger-broken-no-replay-mark` must fail.

| Case                                 | Finding                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ledger-finding-404-while-creating`  | P1-B (Boat silence): a 404 read before `created_seen_at` was set is committed as not-found after it.                 |
| `ledger-finding-snapshot-before-key` | P1-C (Boat silence): a replay refused for its deleted source snapshot records never-created while Boat holds the VM. |
| `proof-finding-start-race`           | P2-A: a rotation or removal commits between the check's account read and its ledger insert.                          |
| `proof-finding-claim-overlap`        | P2-B: a check that outlives its claim is settled from the sweep's stale copy.                                        |
| `proof-finding-late-save`            | P2-C: a save sealant gave up on lands after the check's snapshot delete answered 404.                                |
| `proof-finding-404-while-creating`   | P2-D (Boat silence): `deleteVm`'s poll takes a 404 for a VM still being created.                                     |
