# @sealant/api-contracts

## 0.3.0

### Minor Changes

- bf3dc5e: `updateRun` accepts optional `diff` and `changedFiles` on terminal status transitions, so callers
  that observed a run's file changes (e.g. the SSH gateway finalizing an interactive session) can
  persist them alongside the status flip.

## 0.2.0

### Minor Changes

- 6234d20: First public release of the fluent SDK.
  - `harness.run(prompt)` — blocking one-shot execution: registers the run server-side, resolves
    once terminal with the captured changes (files + diff) inline.
  - `harness.start(prompt)` — non-blocking: same server-side run, returns the live `Run` handle
    immediately; stream progress with `run.record.stream()` and settle with `run.wait()`.
  - `run.wait()` now fetches the server-side captured changes once the run is terminal, so handles
    from `start()` and `runs.get()` settle with an honest diff.
  - Execution-record read surface: `replay()`, `timeline()`, `stream()`, `scrollback()`,
    `commands()`, `transcript()`, `loss()`, `summary()`.
  - `@sealant/api-contracts` ships as the contract-first HTTP API definition the SDK's client is
    derived from.
