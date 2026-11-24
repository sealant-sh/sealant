# Capture removal ledger: model-checked

A TLA+ model of how sealant decides, under one run's drain record (`workspace_capture_drains`), that
the run's executor may be removed, and keeps every other path off it while the runtime removes it.
The `capture-removal` skill (`.agents/skills/capture-removal/SKILL.md`) says how to run it, read a
result and keep it in step with the code. This file is the record: what is verified, under which
bounds and assumptions, and what the check found.

Confirmed against the code at `8c2cbd88` (main, 2026-11-15), and against SLNT-978's change to a
drain's `save` (2026-11-21). Read again at `7c239dd9` (SLNT-1318, 2026-11-24): the recovery sweep
keeps a host VM whose recovery boot said "nothing to save" unless sealant's records show a warm
standby nobody claimed, a retry before the removal the model already has, with no ledger write of
its own; no model change. Run with tlx at the commit `docs/formal/tlx.sh` pins ("The checker"
below).

## The promise

The executor is removed only on the evidence about it that is current, with no observation of it in
flight, and nothing is asked of it between that decision and the runtime removing it. The harm when
it breaks: an executor whose disk holds work nobody saved is deleted, and the work is lost.

Checked as seven invariants (`CaptureRemovalLedger.tla`, "The promises"):

| Invariant                   | In plain words                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SentOnCurrentEvidence`     | Every removal request is sent on the evidence its decision was made on, still current, with no observation in flight: the first, a reissue, and a re-based reissue. |
| `NothingAskedBeforeRemoval` | No observation is opened and no recovery admitted between a request being sent and the runtime removing the executor on it.                                         |
| `RemovalStaysIssued`        | The runtime removes the executor only while the ledger holds that removal issued: an issued removal is never given up while a request of it may still act.          |
| `DeletedMeansGone`          | A row recorded deleted is an executor the runtime no longer has.                                                                                                    |
| `DeletedIsFinal`            | Once deleted, always deleted: nothing is authorized over it.                                                                                                        |
| `NothingAskedOfDeleted`     | No observation is opened of an executor recorded deleted.                                                                                                           |
| `RecoveryExclusive`         | While a recovery claim is live, only that recovery is authorized to remove the executor.                                                                            |

"A status recorded after authorization voids a removal not yet sent" (slice 1's invariant 4 on
SLNT-1006) is part of `SentOnCurrentEvidence`: the bump that voids it is what `issueDeletion`
refuses on. "One holder, one request per token" holds by the model's construction (one
`deletion_token`, `reqs[t]` written once) rather than as a separate invariant.

## The drain label

The same row carries the drain label (`state`): what a person reads about the run's work. `gone` and
`stopped` are terminal, the executor removed with nothing on record saying its work was saved, or on
evidence that it was; `kept`, `stop-failed`, `draining` and `saved` are not. The label belongs to
this model, not Boat custody's: it is a column of the same row, written by the same deleters,
recovery and drains, and it is right only relative to the removal it reports (SLNT-1006, slice 3).

| Invariant                   | In plain words                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `LabelNeverWeakened`        | Once the label is terminal, no write weakens it: not to a weaker terminal label (`stopped` to `gone`), not to a non-terminal one. |
| `TerminalLabelMeansRemoved` | A terminal label means the runtime no longer has the executor.                                                                    |

`TrackLabel` turns the label and the drain claim on; the removal cases leave them out, so their
state counts are the removal ledger's alone. `discarded` is out of scope (a discard removal carries
no ledger ticket).

## Actors

- **Deleters** (the stop job, the runtime-exit reconciler, the orphan reaper): look at the runtime,
  read the record, decide, `authorizeDeletion`, `issueDeletion`, the runtime call, then
  `completeDeletion`, `releaseDeletion` or `lapseIssuedDeletion`. A deleter that reads a removal
  issued with its hold lapsed settles it (`reconcileIssuedDeletion`) from what it saw of the runtime
  and, when its own decision authorizes the same removal, the version it read. Each may die after
  authorizing, after issuing, or with its call out.
- **Observers** (the drain worker, the API's flush and status routes): `openObservation` before
  asking, then `recordStatus`, `closeObservation` or `endObservation`. Each may die with its fence
  open; a fence lapses at its TTL and is resolved by a later answer opened after it lapsed.
- **Recovery** (one attempt): `claimRecovery`, a first decision on its claim, `admitRecovery`, a
  second decision after it. Its claim may lapse.
- **Label writers**: a deleter records `stopped` after its removal (`observe`, ranked by
  `drainLabelsOutranking`), `gone` or `stopped` when the runtime has nothing of the executor, and
  `kept` when it keeps it (`markRetained`, unranked); the stop job records `stop-failed` when its
  runtime call fails (unranked). A drain records its outcome with `save` (`recordProgress`, fenced
  on the drain claim), which keeps a terminal label (`drainLabelsKeptOverProgress`, SLNT-978). Only
  the stop job and the drains hold the drain claim; it may lapse.
- **Attestation**: `attestCompletion` moves the evidence without asking the executor.
- **The runtime**: carries out a request while its bound has not passed, refuses it, or leaves its
  outcome unknown to the caller.

## Bounds

| Case                   | Group | Deleters | Observers | Recovery | Tokens | Attestations | Crashes | Distinct states | tlx, 4 workers |
| ---------------------- | ----- | -------- | --------- | -------- | ------ | ------------ | ------- | --------------- | -------------- |
| `ledger`               | fast  | 2        | 2         | no       | 3      | 1            | 1       | 1,218,892       | 2 s            |
| `ledger-recovery`      | fast  | 1        | 2         | yes      | 3      | 1            | 1       | 6,603,314       | 5 s            |
| `ledger-deep`          | deep  | 2        | 2         | no       | 4      | 2            | 2       | 4,487,744       | 3 s            |
| `ledger-recovery-deep` | deep  | 1        | 2         | yes      | 4      | 2            | 2       | 23,459,590      | 21 s           |
| `label-fixes`          | fast  | 2        | 2         | no       | 2      | 0            | 1       | 2,776,762       | 2 s            |
| `label-fixes-deep`     | deep  | 2        | 2         | no       | 3      | 1            | 1       | 19,115,752      | 15 s           |

A third deleter, or a second deleter beside the recovery attempt, takes the state space past 170
million distinct states within 15 minutes on four TLC workers with the queue still growing. Those
bounds are left out; a second settler is still present in `ledger` and `ledger-deep` (the deleter
that did not issue), and in the recovery cases (the recovery attempt settles what the deleter
issued).

The `label-*` cases turn the drain label on, with `d1` the stop job and `o1` a drain (the other
observer an API route).

Tokens count every removal minted (authorizations and reissues together); a deleter that would mint
one past the bound stops. Each observer observes once. Holds, fences, claims and the runtime's bound
lapse at any moment: the model has no clock, only whether each has passed.

## The checker

tlx, a TLA+ checker written in Rust, at the commit `docs/formal/tlx.sh` pins, run with `-tlc` (TLC's
verdicts, counts and depth); `check.sh --engine tlc` runs TLC 2.19 for a cross-check by hand. On
2026-11-17 (SLNT-1081), at main `da895e73`, every case gave the same verdict under both and every
case that must pass reached the same count; the cases that must fail reached the same count too, run
with one worker under both. The whole `--deep` run took 50 s with four tlx workers, against about 11
minutes for TLC on the nightly's four-core runner.

## Assumptions

- **A request goes out before the runtime's bound passes.** `removalFenceMs` is measured from
  `issueDeletion`'s write, and `reconcileIssuedDeletion` releases an issued removal whose evidence
  moved once it has passed. The code assumes the deleter's runtime call leaves soon after that
  write. Between them run `onIssued` (the stop's `onPhase` "removing") and the caller's own steps,
  which nothing bounds. The microVM runtime, the only one that declares a bound, sums its read and
  terminate bounds (90 s), AWS's 15-minute signature window and a 3-minute margin: its requests are
  signed within 90 s of `adapter.stop` starting, so a deleter that takes more than about 3 minutes
  between `issueDeletion` and `adapter.stop` can send a request the ledger has already given up.
  `assumption-send-outlives-bound` turns the assumption off and must fail; its trace is under
  "Findings".
- **A fence outlives its request.** An observer's fence lapses only after its round trip's bound
  plus a margin (`OBSERVATION_FENCE_MARGIN_MS`); an answer arriving after that may still be
  recorded, as the model allows, but the daemon answered it before the later observation that
  resolved the fence.
- **Deciding is abstract.** A deleter may decide to remove or keep on any record, except that it
  never keeps an executor the runtime told it is gone (`decideExecutorDeletion` removes it on basis
  `missing` or on the evidence). The model checks that a removal rests on the evidence it was
  decided on, not that the decision weighed it rightly (`decideExecutorDeletion` has its own tests).
- **A drain's non-terminal outcomes are one.** `draining` stands for `draining`, `saved` and `kept`
  from a drain: they rank the same.
- **Out of scope.** Removals that rest on no recorded evidence (the owner's discard, a missing
  executor, not capture-sourced, nothing to save) carry no ticket and pass by this ledger. The
  `discarded` label is not modelled. The database trigger (`workspace_capture_drains_invariants`)
  that holds writers from an older release to the contract is not modelled: every writer here is
  current.

## Broken variants

Each turns off one of main's guards and must fail on the invariant it protects. Each passes the
other invariants' checks or not as it may; its case lists only its own.

| Case                                  | Guard turned off                                                                                  | Fails                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `broken-issue-skips-evidence`         | `issueDeletion`'s `deletionEvidenceCurrent`                                                       | `SentOnCurrentEvidence`     |
| `broken-reissue-on-stale-decision`    | `reconcileIssuedDeletion`'s `reauthorizedVersion === evidenceVersion` (the re-authorized reissue) | `SentOnCurrentEvidence`     |
| `broken-observe-while-issued`         | `openObservation`'s refusal of `deleting-issued` whatever its hold                                | `NothingAskedBeforeRemoval` |
| `broken-release-over-unknown`         | `releaseDeletion` keeping the removal issued while another request's outcome is unknown           | `RemovalStaysIssued`        |
| `broken-release-before-bound`         | `reconcileIssuedDeletion` releasing only when `fenced`                                            | `RemovalStaysIssued`        |
| `broken-complete-on-unknown`          | `completeDeletion` only on the runtime call's success                                             | `DeletedMeansGone`          |
| `broken-authorize-over-deleted`       | `authorizeDeletion`'s `deleted` answer                                                            | `DeletedIsFinal`            |
| `broken-observe-deleted`              | `openObservation`'s refusal of `deleted`                                                          | `NothingAskedOfDeleted`     |
| `broken-authorize-over-recovery`      | `authorizeDeletion`'s `recovering` answer                                                         | `RecoveryExclusive`         |
| `broken-label-unranked`               | `recordObservation`'s `drainLabelsOutranking` (before SLNT-968), with the proposed label fix on   | `LabelNeverWeakened`        |
| `broken-save-unranked`                | `recordProgress`'s `drainLabelsKeptOverProgress` (before SLNT-978), with the label fix on         | `LabelNeverWeakened`        |
| `broken-missing-without-gone-runtime` | a removal on basis `missing` only on the runtime's word that it has nothing of the executor       | `TerminalLabelMeansRemoved` |

## Findings

Within the bounds above, main keeps every invariant of the removal ledger, and breaks
`LabelNeverWeakened`.

### A terminal drain label overwritten by a later writer (SLNT-1012)

Case `finding-label-weakened`, expected to fail until the code changes; `label-fixes` and
`label-fixes-deep` turn the proposed fix on (`UnrankedKeepsTerminal`: `markRetained` and a
non-terminal `observe` keep a terminal label) and pass with every invariant. #660 (SLNT-968) ranks
terminal labels inside `recordObservation` only, and two writes still bypass it.

A third, a drain's `save` writing over a removal another path made, is fixed (SLNT-978; case
`broken-save-unranked` restores it): a deleter that does not hold the drain claim (the owner's
discard, the runtime-exit reconciler, the reaper, recovery) removed the executor and recorded it,
and a drain that held or then took the claim saved `draining` over it. `recordProgress` now keeps a
terminal label.

`kept` after `stopped` (the shortest trace):

1. The reconciler looks at the runtime while it still has the executor.
2. The stop job removes it on saved evidence and records `stopped`.
3. The reconciler decides to keep on its earlier look, and `markRetained` writes `kept` (and a
   retention) over `stopped`.

In each case traced through the code a later writer restores `stopped` (the stop job's repeated
call, the next recovery pass), so nothing is lost: the run reads wrong for a while, the reconciler
logs an error, and recovery makes a pointless attempt.

### A request sent after the runtime's bound passed (timing assumption)

Case `assumption-send-outlives-bound`. Needs a deleter to stall between `issueDeletion` and its
runtime call for longer than `removalFenceMs`.

1. A deleter authorizes a removal on saved evidence and `issueDeletion` records it issued.
2. The deleter stalls before its runtime call goes out (in `onIssued`, or anywhere before
   `adapter.stop`), past the runtime's bound as the ledger measures it from step 1.
3. It sends the request; the call ends with an outcome nobody knows (`lapseIssuedDeletion`).
4. An attestation moves the evidence.
5. Another deleter finds the removal issued with its hold lapsed, the runtime still has the
   executor, the evidence moved and the bound passed: `reconcileIssuedDeletion` answers `released`.
   Observations and recovery resume.
6. The late request removes the executor while the ledger says no removal is under way. The evidence
   that moved in step 4 is never weighed.

How likely: rare. It needs a stall of minutes in one process between a database write and the call
it guards, an outcome nobody knows, an evidence change and a settling pass in that window, and only
the microVM runtime declares a bound (the others never release an issued removal this way). Filed as
SLNT-1010 rather than fixed here.
