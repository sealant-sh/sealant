# Boat custody: model-checked

Two TLA+ models of how Core keeps track of what it makes in a Boat account, checked with TLC. The
`boat-custody` skill (`.agents/skills/boat-custody/SKILL.md`) says how to run them, read a result
and keep them in step with the code. This file is the record: what is verified, under which bounds
and assumptions, and what the check found.

Confirmed against the code at `dd39b9de` (main, 2026-11-13). Run with TLC 2.19 (TLA+ tools 1.7.4,
from the nixpkgs this repository's `flake.lock` pins).

## The two promises

**The run ledger** (`BoatRunLedger.tla`). Core never records a Boat run as absent (`never-created`,
`not-found`, `deletion-completed`), and so never stops tracking it, while Boat may hold a VM for it.
The harm: a session VM has no auto-stop, so it bills by the second with nothing in Core that will
ever delete it. Invariant `NoForgottenVM`.

**The full check's ledger** (`BoatKeyProof.tla`). Whatever a full check of a Boat key made (a
throwaway VM and a saved snapshot) is eventually deleted, on every path, and the account's key is
never erased or replaced while something the check made still exists. The harm: a saved snapshot
holds one of the account's ten included slots, or bills by the day, for ever; a VM bills until its
15-minute auto-stop and then stays as a stopped sandbox. Invariants `NothingLeftWhenSettled`,
`KeyKeptWhileLeftover`; liveness `EventuallyDeleted`.

## Findings

Seven schedules break a promise on main; the model finds each one, and each has its own case in
`cases/` that is expected to fail until the code changes. Four need no silence of Boat's; three do
(marked), and one of those (P1-C) needs a Boat behaviour the docs arguably rule out. For each but
P2-D a proposed fix is expressed in the model, and the `-fixes` cases pass with every schedule on
(P2-D's silence aside): within these bounds these are the only breaks. P1-A matters most: its
trigger is an owner stopping a workspace in the second its VM is being asked for.

### P1-A: a stopped launch records never-created while the sweep's replay makes the VM

Case `ledger-finding-replay-during-first-create`. Needs no silence of Boat's.

1. A launch wins `issueCreate` and sends the first create.
2. The owner stops the workspace. The stop route accepts a stop once the run's pending runtime row
   exists, and the stop job (`processWorkspaceStop`) finds no VM on record (`resource_id` null), so
   it skips the adapter and runs `markStopped`: `status = 'stopped'`, guarded only on
   `status <> 'stopped'`. The launch goes on. (A launch whose lease lapsed, because its worker
   stalled or could not reach the database for the two minutes of `DEFAULT_LAUNCH_LEASE_MS`, gets to
   the same place: `ledger-lease-lapse` turns that on.)
3. A VM sweep reads the run: `launchInFlight` (status `pending` and a live lease) is false, so
   `resolve` loads it as `issued`.
4. Boat refuses the first create for a reason in `DEFINITE_REFUSALS` (the plan's running limit,
   say). `firstCreateRejected` holds, and the launch commits `recordNeverCreated`.
5. The sweep's discovery finds no VM; the run is inside its 23-hour window, so it replays the create
   under the same key. `resolve` does not read the row again before it sends. Boat has released the
   failed key ("within about 2 minutes", api/v1.md) and the limit has room again: the replay makes
   the VM.
6. The sweep's `adopt` is refused: the row is absent. Nothing lists the run again.

A second form needs a silence: the sweep's replay reaches Boat first and makes the VM, and the
launch's first create, now a second request under a linked key, is refused for the limit that VM
just filled (if Boat checks limits before it looks up the key, which "each retry ... returns that
same sandbox" arguably rules out).

How likely: rare, but its trigger is ordinary: a stop in the second or so a first create takes.
Beyond it, a sweep must load the run in that window (one runs every 30 s), the refusal must be one
whose cause can clear in seconds (a running limit or billing, not the key, which the model's
adversary also allows), and the replay must land after Boat released the key and before anything
else takes the slot. Cost: one VM billing without end. Nothing in Core finds Boat VMs it has no row
for.

Proposed fix (`MarkReplayBeforeSend`): one guarded statement marks the row (`replay_issued_at`,
`WHERE absent_at IS NULL`) before any replay is sent, and the first create's `recordNeverCreated`
also requires `replay_issued_at IS NULL`. Whichever commits first wins: a marked replay keeps the
run tracked, and a recorded absence stops the replay.

### P1-B: a 404 read before the VM was seen created is committed after it (silence)

Case `ledger-finding-404-while-creating`. Needs Boat to answer `GET` 404 for a VM it is still
creating, which `observe` (vm.ts) already treats as possible.

1. The owner stops a workspace while its VM is still being created (the launch has adopted it).
2. One observer of the run's VM (the launch's `drive`, or the stop's removal or recovery) reads it:
   404, Boat cannot read it yet.
3. Boat finishes creating it. Another observer reads it past creation; `seen` sets
   `created_seen_at`.
4. The first observer runs `recordNotFound` with its 404. Its guard is
   `created_seen_at IS NOT NULL`, which now holds: absence `not-found` is committed for a VM that is
   running.

How likely: very rare. The gap between one observer's `GET` and its `UPDATE` is milliseconds and
must straddle the moment Boat reports the VM created, and Boat must 404 a VM it is creating at all.
Cost: as P1-A.

Proposed fix (`NotFoundNeedsSeenBeforeGet`): `observe` counts a 404 only if the row it read before
the `GET` already had `created_seen_at` (or `recordNotFound` guards on `created_seen_at` being older
than the `GET`).

### P1-C: a replay refused for its source snapshot when Boat holds the VM (silence)

Case `ledger-finding-snapshot-before-key`. Needs Boat to check a replay's source snapshot before it
looks up the key, and the snapshot to be deleted inside the listing lag. The docs' "Each retry with
the same account, key and request body returns that same sandbox" arguably rules the first out, and
`replayRejected` is written on that reading; Boat has not said. Ask Boat before acting on this one.

1. The first create makes the VM but answers 5xx ("a `5xx` after boat accepted the sandbox").
2. The launch retries: the label listing has not caught up, so it replays.
3. The source snapshot is deleted meanwhile, by Boat removing an unpaid extra or by a person.
   (Core's own image retention, sealant#639, keeps any image a run still pins.)
4. Boat answers the replay `snapshot_not_found`. `replayRejected` holds, and the launch commits
   `recordNeverCreated`.

How likely: very low, and nil if Boat looks up the key first. Cost: as P1-A.

Proposed fix: no refusal of a replay proves absence (`ReplayRejectedKinds = {}` in the model). A run
whose snapshot is truly gone keeps replaying until its window closes and is held
`create-unresolved`.

### P2-A: a removal or rotation commits between the full check's account read and its ledger row

Case `proof-finding-start-race`. Needs no silence of Boat's.

1. The owner asks to rotate the key (or remove the account); `proofLeftovers` reads no check.
2. The owner, or another session, asks for a full check: `proveBoatAccount` reads the account (not
   being removed) and opens its key.
3. `rotate` commits. Its `NOT EXISTS (outstanding proofs)` sees none: the check has no row yet. (For
   removal: `requestRemoval` and `finishRemoval` commit; `finishRemoval` counts no check and erases
   the key.)
4. The check's `start` inserts its row (it reads nothing of the account) and the check creates its
   VM, and later its snapshot, with the key it opened.
5. After a rotation to another Boat account's key (accepted when the account had no runs or images
   to compare against), the sweep's deletes answer 404 and it settles the row; after a removal the
   sweep has no key at all. If the check's own cleanup did not finish, its VM and snapshot stay.

How likely: very rare: the gap is the few milliseconds between the route's account read and the
insert, and an owner must act on the account in it. The invariant breaks as soon as the check makes
something under a key the account no longer has; a leak also needs the check's own cleanup to fail,
since it still holds the old key. (If Boat answers 403 rather than 404 for another account's VM id,
the sweep stays pending on that VM instead of settling; the label search and the snapshot delete
still answer empty and 404.) Removal is narrower still: both `requestRemoval` and the worker's
`finishRemoval` count must fall in the gap. Cost: a saved snapshot for ever, a stopped VM.

Proposed fix (`StartChecksAccount`): `start` inserts only for an account not being removed whose key
revision is still the one the check opened, reading the account row `FOR SHARE` as a run's `reserve`
does, so `rotate` and `finishRemoval` serialize with it.

### P2-B: the check outlives its 15-minute claim and the sweep settles from a stale copy

Case `proof-finding-claim-overlap`. Needs no silence of Boat's.

1. A check starts, and its API process pauses for 15 minutes before it writes `create_issued_at`.
2. The claim passes. The sweep's `toSweep` copies the row: nothing issued.
3. The check resumes, writes `create_issued_at`, sends the create, and dies.
4. The sweep, working from its copy, finds nothing to delete and settles the row. `settle` is an
   unguarded `UPDATE`.
5. Boat makes the VM. Nothing will ever delete it.

The same overlap strands a snapshot when the check pauses between `saveIssued` and sending the save:
the sweep's delete by name answers 404 before the save lands. A form with no stall and no fault
exists too. A check can simply be slow: with every call near its 90 s timeout and its 180 s waits,
its worst case is about 20 minutes. By then the save loop's deadline (`until`, set after the create)
has passed, so it leaves at once with the snapshot still `saving`; the cleanup's delete then gets
Boat's documented `409 save_in_progress` and the check marks the snapshot left. But the sweep took
the row over at 15 minutes and settled it, and `finish` changes nothing on a settled row, so the
snapshot is tracked by no one.

How likely: rare. It needs a stalled API process, or a Boat slow on every call. Cost: as P2-A.

Proposed fix (`FenceCheckOnRow` with `SnapshotLag`): the check's `createIssued` and `saveIssued`
`UPDATE`s require `finished_at IS NULL` and stop the check when they hit no row; `settle` requires
`create_issued_at` and `save_issued_at` to be what the pass read; and see P2-C.

### P2-C: a save Core gave up on lands after the check's delete answered 404

Case `proof-finding-late-save`. Needs Boat to commit a save after Core's call ended without an
answer, and after a later `DELETE` of the name was answered 404. The docs say a save answers `202`
at once with the snapshot `saving`, and a `DELETE` while saving answers 409, so this needs Boat to
be slow to register a request it already received, or a connection reset with the request handled
later. Boat does not rule either out; it is an assumption about Boat, not about the code.

1. The check sends the save. The call ends without an answer (its 90 s timeout).
2. The cleanup deletes the snapshot by name. Boat has not registered the save yet and answers 404,
   which `deleteSnapshot` takes for done; `snapshot_deleted_at` is written.
3. Boat registers the save: the snapshot exists.
4. The check deletes its VM and finishes with nothing pending. The snapshot stays for ever.

How likely: rare (Boat slower than 90 s to register a save). Cost: a saved snapshot for ever.

Proposed fix (`SnapshotLag`): a snapshot `DELETE`'s 404 counts as deleted only once the save was
issued ten minutes ago, as the VM's empty label search already does
(`BOAT_KEY_PROOF_LISTING_LAG_MS`). Before that the check leaves `cleanup_pending` and the sweep
looks again.

### P2-D: the check's delete takes a 404 for a VM still being created (silence)

Case `proof-finding-404-while-creating`. Needs Boat to answer `GET` 404 for a VM it is creating.

1. The check's create reply is lost; its cleanup finds the VM by its label while Boat is still
   creating it.
2. `deleteVm` sends `DELETE`; the call ends unanswered and Boat did not act on it.
3. The poll's `GET` answers 404 for the VM still being created, which `deleteVm` takes for done.
4. The check finishes with nothing pending. The VM starts, bills 15 minutes, and stays stopped.

Proposed fix: count the poll's 404 only after Boat answered the `DELETE` with its operation.

## How the models were checked against the code

Each action names the code it stands for (the coverage record is in the skill). An independent
review read every action against the code and tried to refute each finding: it confirmed that the
code can take every step of all seven, and found one gap that changed a verdict. The stop job's
`markStopped` makes `launchInFlight` false while a launch runs, which the first model left out; with
it modelled, P1-A needs an owner's stop rather than a two-minute stall. It also pointed out that
Boat answers a `DELETE` of a snapshot still saving with `409 save_in_progress`, now in the model,
which gives P2-B its form without a stall.

## Each property fails on a broken variant

| Property                 | Broken variant (case)                                                                                                                  | What the model finds                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoForgottenVM`          | `ledger-broken-pre634`: vm.ts before sealant#634's review round, where a replay refused for `DEFINITE_REFUSALS` recorded never-created | The first create makes the VM but answers 5xx; the listing lags; the replay is refused `api_key_expired`; `recordNeverCreated` (14 steps). The reviewer's leak. |
| `KeyKeptWhileLeftover`   | `proof-broken-pre638`: removal and rotation before sealant#638's review round, which never read `boat_key_proofs`                      | A check creates its VM; the owner rotates the key meanwhile (8 steps). The reviewer's finding.                                                                  |
| `NothingLeftWhenSettled` | `proof-broken-no-listing-lag`: the sweep trusts an empty label search at once                                                          | The check's create reply is lost and it dies; the sweep's search, before the list shows the VM, settles the row (14 steps).                                     |
| `EventuallyDeleted`      | `proof-broken-no-pending-live`: `finish` never sets `cleanup_pending`                                                                  | The check's cleanup misses its VM and finishes clean; no sweep looks again; the account can then be removed.                                                    |

The skill's own run on a scratch change (`running-limit` added to what `replayRejected` treats as
definite) failed `ledger` with the same leak as the review's, and passed again once the change was
dropped.

## Bounds

Run ledger: one run (one idempotency key, so at most one VM); one launch with one drive retry (two
in `ledger-lease-lapse`); one VM sweep (two in `ledger-two-sweeps`); the stop job; the stop's
removal; the convergence sweep; one other observer (`inspect` for a ready run, recovery for a
stopping one); at most three creates sent, one reply lost after Boat acted, one crash of the launch,
one stop request at any point, the 23-hour window closing once, and in `ledger-lease-lapse` and the
`-fixes` case one lapse of a live launch's lease. Sweeps and the removal may end a pass at any step,
any number of times. A call may end unanswered before Boat acted on it, any number of times.

Full check: one stored account; one check; one sweep; one removal; one rotation; at most two Boat
faults in all (refusals or lost replies), one crash of the check, two sweep passes ending halfway
(one in liveness).

## Assumptions

- Boat never makes a second VM under an idempotency key it linked to one, and Core sends no replay
  once its 23-hour window has closed (Boat keeps keys 24 hours). The model does not let Boat forget
  a key.
- A refusal Boat answers with its own code means it made nothing ("Create that failed before the
  sandbox existed"). A 5xx Boat sent no code with is `no-answer`: it may have made the VM.
- Boat's `GET` 404 for a VM it reported past creation means the VM is gone, and a `DELETE` Boat
  accepted ends the VM's billing at once (data-retention/delete.md).
- Time, where the code relies on it: a request reaches Boat within its timeout or never; the check
  does not pause ten minutes between writing `create_issued_at` (or `save_issued_at`) and sending;
  Boat's list shows a VM within ten minutes of making it. `LagPasses` and `ClaimPasses` in
  `BoatKeyProof.tla` encode these.
- Postgres: each statement is atomic and a guarded `UPDATE` serializes on its row. A transaction's
  separate `SELECT` and `UPDATE` are two steps (read committed): `finishRemoval` is.
- One clock in the full check. Its claim (`claimed_until`) and its `create_issued_at` are written by
  the API process's clock and compared with the worker's (`toSweep`, the listing lag). A skew of Δ
  between the two hosts shortens the claim and the lag by Δ; at about ten minutes it is
  `proof-broken-no-listing-lag`. The run ledger uses the database's clock throughout.
- The full check's `definiteRefusal` takes any refusal with a Boat code as "no VM", rate limits and
  no-machine included (the launch keeps those ambiguous). That holds while Boat never sends a coded
  5xx after accepting a sandbox; the model's Boat never pairs a refusal with a VM.

## Boat's silences

Where the docs say nothing, a constant lets the adversary do either. Main's own reading is the
`ledger` and `proof` cases; the `finding` cases turn one silence on.

| Silence                                                                  | Constant                   | What depends on it                                           |
| ------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------ |
| Boat checks limits, billing or a trial before it looks up a replay's key | `LimitCheckedBeforeKey`    | Nothing on main (on in every case); the second form of P1-A. |
| Boat checks a replay's source snapshot before its key                    | `SnapshotCheckedBeforeKey` | P1-C                                                         |
| `GET` answers 404 for a VM Boat is still creating                        | `GetMay404WhileCreating`   | P1-B, P2-D                                                   |
| A failed create's key is released "within about 2 minutes"               | (any moment in the model)  | P1-A's main form                                             |

## Not covered

- Rotating a stored account to another Boat account's key while it has runs. Workers re-read the key
  revision every 10 s (`BoatAccountDirectory`, `revisionCheckMs`), so a launch can create with the
  old key after the new one is stored, and the new key's reads answer 404 for that VM. The suggested
  next target.
- Image builds and their saved snapshots (`images/boat/`), image retention (sealant#639), and what
  is released after an absence (the tunnel, the gateway, the publication pin).
- That a stopped run's VM is eventually deleted (a liveness property of the run ledger). By design
  some VMs are kept (a FINAL not confirmed) or held for an operator.
- Two runs sharing an account's limits, the install's own key (`default`), a second check of the
  same account (a unique index on unfinished rows prevents it).
- The TypeScript itself. The models are written by hand; they are as close to the code as the
  coverage record in the skill says, at the commit above.

## In CI (not added)

A job that installs Nix and runs `docs/verification/boat-custody/check.sh` on pull requests touching
the files in the skill's coverage record would take about a minute; `--deep` (about 40 minutes on 32
cores) suits a nightly run.
