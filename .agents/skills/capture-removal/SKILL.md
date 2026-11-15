---
name: capture-removal
description:
  Model-check the capture removal ledger (TLA+): an executor is removed only on current evidence
  with no observation in flight, and nothing is asked of it until the runtime removes it. Use when a
  change touches removal authorization, observation fences, issued-removal settlement or recovery
  admission (workspace-capture-drains.ts, capture-drain.ts, capture-drain-ledger.ts,
  recover-retained-executors.ts), or to rerun or update the model.
---

# Capture removal ledger

`docs/formal/capture-removal/CaptureRemovalLedger.tla` holds the ledger over one run's drain record
(`workspace_capture_drains`) to its promise: the run's executor is removed only on the evidence
about it that is current, with no observation in flight, and nothing is asked of it (no observation,
no recovery) between that decision and the runtime removing it. The harm when it breaks: an executor
whose disk holds work nobody saved is deleted.

Each step of the model is one ledger transaction (the Postgres repo; the in-memory ledger keeps the
same contract, checked by `capture-drain-ledger.conformance.db.test.ts`) or one runtime call. The
runtime is an adversary bounded by its adapter's promise (`removalFenceMs`). The record, with the
bounds, the assumptions and what the check found, is `docs/formal/capture-removal/README.md`. Read
it before you judge a counterexample.

**Coverage and sync commit: `docs/formal/capture-removal/COVERAGE`.**

## 1. Does the change touch it?

```bash
pnpm verify formal --all
```

Its `drift:capture-removal` step names each covered file that differs from `sync`.
`pnpm verify plan` owes this model when a diff touches a covered file, and CI's `formal` job fails a
pull request that changes covered code but neither the model nor `sync` (the drift guard).

Read each changed hunk against the coverage record below. A hunk that changes what a covered
function does (a guard, the order of two writes, which outcome leads where, a new writer of a
`deletion_*`, `observation_fences`, `evidence_version` or `recovery_lease_*` column) goes to step 2.
A hunk that leaves every covered function's behaviour as it was (logging, types, display state,
schedules) needs no model change: note it for step 5.

## 2. Mirror the change in the model

- A guard is the `CASE` arm of its action, in the code's order.
- A new transaction or runtime call is a new step with its own `pc` value, so a crash and every
  other actor can fall between it and its neighbours.
- `evidence_version` is not a number in the model: every stored or read version is a flag, TRUE
  while it is still current (`dcur`, `seenCur`, `basisCur`). A write that bumps the version calls
  `Bump` (or `BumpVoiding`) and sets `dcur'` itself.
- main's guards live once, in the `Code…` definitions near the top; the cases substitute them
  (`<-`). Edit the definition, not the cases. Only `broken-*` cases set their own values.
- Every action says what happens to every variable: list the ones it leaves alone in `UNCHANGED`.

A new guard gets a `broken-*` case that turns it off and must fail on the invariant it protects.

## 3. Run the check

```bash
docs/formal/capture-removal/check.sh          # fast cases, the quick bounds
docs/formal/capture-removal/check.sh --deep   # every bound, as nightly runs it
```

Done when the last line is `Every case gave its expected verdict.` and the exit status is 0. The
fast cases take under a minute on four cores; `FORMAL_WORKERS` caps TLC's threads (set it on a
shared machine). `--trace` also prints the counterexample of the cases meant to fail; name cases to
run only those (`check.sh ledger`). The checker is TLC 2.19 from the nixpkgs this repository's
`flake.lock` pins; without Nix, set `TLA2TOOLS_JAR` (tools v1.7.4) with Java 11 or later.

A case states its module, the verdict it must give and its group; a case that must pass pins its
distinct-state count (`states`) and ends `ok` only when both match. `ledger*` cases are main's code;
`broken-*` are broken variants that must fail; `assumption-*` turn off a timing assumption the code
relies on, and must fail.

## 4. Read the result

A `FAIL` line prints the counterexample, one line per step: the action, then what it changed. Read
each step in the code its action names, and decide:

- **Modelling error**: the trace takes a step the code cannot take in that state. Fix the model.
- **Timing the code relies on**: the trace needs a process to stall longer than a bound the code
  measures from a ledger write (a fence's TTL, `removalFenceMs`). Encode it as a constant beside
  `SendMayOutliveBound`, add an `assumption-*` case and the record's assumptions.
- **Real break**: every step is one the code can take. Leave the property and the bounds as they
  are. Tell the counterexample as steps in the code's words, add a `finding-*` case expected to
  fail, record it in the README, and file it.
- `got error` is a broken model: usually an unassigned variable (`not completely specified`).

An unexpected `pass` on a `broken-*` or `assumption-*` case means the model no longer reaches that
schedule: find out why before you change its expectation.

## 5. Record it

Once the model describes the code at your commit and `check.sh --deep` gives every expected verdict,
update the `states` pins your change moved, the coverage record below and the README. Then move
`sync` in `COVERAGE`, and the README's "Confirmed against" line, to that commit, only after reading
every covered hunk since the old one.

## Coverage record

| Code                                                                                                                      | Model                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `workspace-capture-drains.ts` `authorizeDeletion`                                                                         | `Authorize`                                                             |
| `confirmDeletion`, `issueDeletion`                                                                                        | `Renew`, `Issue`                                                        |
| `reconcileIssuedDeletion` (`fenced`, `reauthorizedVersion`)                                                               | `Settle`, `Fenced`, `Reauthorized`                                      |
| `completeDeletion`, `releaseDeletion`, `lapseIssuedDeletion`                                                              | `Succeed`, `Release` (`NotSent`, `Refused`), `Unknown`                  |
| `openObservation`, `recordStatus`, `closeObservation`, `endObservation`                                                   | `Open`, `Record`, `Close`, `End`; `FenceLapses`                         |
| `attestCompletion`                                                                                                        | `Attest`                                                                |
| `claimRecovery`, `admitRecovery`, `releaseRecovery`                                                                       | `Claim`, `Admit`, `EndRecovery`; `ClaimLapses`                          |
| `capture-drain.ts` `authorizedDeletion`, `settleIssuedRemoval`                                                            | `Look`, `Read`, `Authorize`, `Settle`                                   |
| `removeUnderDeletion`, `removalFailed` (`isRemovalRefusal`, `isRemovalPending`), `DELETION_HOLD_MS`                       | `Issue`, `Send`, `Renew`, `Succeed`, `Refused`, `Unknown`, `HoldLapses` |
| `observedAnswer`, `ledgerObservationRecorder`; the in-memory ledger                                                       | the observer steps; the same contract                                   |
| `capture-drain-ledger.ts` (each call wraps one repo transaction; a failure fails safe)                                    | the steps above                                                         |
| `recover-retained-executors.ts`: the first `authorizedDeletion` on the claim, `admitRecovery`, the removal after recovery | `Claim`, the recovery's first `Read`, `Admit`, its second round         |
| A runtime adapter's `removalFenceMs`                                                                                      | `BoundPasses`, `elapsed`, `SendMayOutliveBound`                         |
