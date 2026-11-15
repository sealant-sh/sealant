---
name: verify
description:
  Prove a sealant change works beyond its tests with `pnpm verify`: what the diff owes, the checks,
  gated suites and models, the running stack, screenshots and the verdict. Use before a PR opens,
  and for every change to the web app, API or SDK.
---

# Verify a sealant change

A passing suite is not proof: prove the change by using it. `pnpm verify` does the running; this
skill says which verbs, in which order, and why. Each verb prints one result (`--json` on stdout),
keeps it under `.verify/`, and exits 0 only on `passed`. A skip is never a pass.

## 1. Say what you expect

Before running anything, write what the screen or response shows if the change works, what it shows
if it doesn't, and which existing screen it alters. The evidence is judged against this, not against
whatever the run happened to show.

## 2. Plan, then check

```bash
pnpm verify plan
pnpm verify check
```

`plan` lists what the diff owes and the CI jobs it will run; the steps below are where each kind of
obligation goes. `check` is AGENTS.md's pre-PR gate. Its `skipped` means a suite the diff owes did
not run: run the `next` command it prints instead of reading past it.

**Done when** `check` exits 0.

## 3. Discharge what the plan owes

- A gated suite: `pnpm verify db <suite>`, which needs Docker.
- A formal model: `pnpm verify formal`. On a drift failure, the area's skill (such as
  `boat-custody`) says how to read the hunks against the model.
- The Boat harness: `pnpm verify boat-harness --preflight` first. A run blocked by a held lock,
  another run's leftovers or a missing WireGuard stops after you have waited for it. Then run the
  `pnpm boat:harness <file>` lines it prints, which are the groups the diff needs.
- A live Boat launch: `pnpm verify runtime --runtime boat --live`. Without the credentials it is
  `requires_external_observer`; say that in the verdict, never that it works.

## 4. Run it and look at it

For a change to the web app, API or SDK:

```bash
pnpm verify stack up
pnpm exec playwright install --only-shell chromium     # once per Playwright version
node .agents/skills/verify/scripts/shot.mjs /workspaces=workspaces /settings/ssh-keys=ssh-keys
```

`shot.mjs` signs in (on an empty database it creates the local account through `/setup`) and saves
full-page PNGs to `.verify/shots/<commit>/`. For a flow, such as a dialog or a form, import its
`withSignedInPage`, `open` and `shoot` from a scratch script outside the repo, by absolute path.

Screenshot every state the change touches, its empty and error states included, then open each PNG:
a blank or half-rendered frame is a failed run, not evidence. When the change alters an existing
screen, take the same shots on `main` so the PR shows before and after. Start the worker and SSH
gateway (`docker compose --profile apps up -d --build`) only when the change builds or runs a
workspace.

**Done when** you have looked at a screenshot of every state from step 1. Then
`pnpm verify stack down`.

## 5. Evidence and verdict

```bash
pnpm verify evidence
```

On a clean tree it gathers this commit's results, logs and screenshots into
`.verify/evidence/<commit>/`, scans them for secrets, and writes `verdict.md`. A file with a hit is
deleted and the result is `evidence_withheld`: report it as withheld. The scan cannot read a
screenshot's pixels, so look before you attach one. Fill in the verdict's "What I saw" and "Not
checked" yourself, then post it with one `--attach` per screenshot:

```bash
gh pr comment <number> --body-file .verify/evidence/<commit>/verdict.md \
  --attach .verify/evidence/<commit>/shots/workspaces.png
```
