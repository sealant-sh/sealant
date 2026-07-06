# @sealant/sdk

## 0.5.0

### Minor Changes

- 0d2ce1c: Inference on connected accounts. New `inference` contract group: `POST /v1/inference/respond` runs
  short, tool-calling inference loops on the caller's own subscription — the server resolves the
  connected-account reference (same shape as workspace creation), decrypts, and invokes the OFFICIAL
  Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (never raw model-API calls on stored credentials,
  per the connected-accounts design's hard constraint). Caller-defined JSON-schema tools are exposed
  to the model verbatim; tool calls park server-side and the CALLER executes them, posting results
  back in a multi-turn session loop. Structured output rides the agent SDK's native json_schema output
  format. SDK: `sealant.inference.respond(...)` (new exchange or continuation) + `inferenceRespondOp`
  in the Effect core. Usage is attributed per account (`last_used_at`), and a live auth rejection
  marks the account invalid. Claude accounts only; Codex inference is a stated follow-up.
- 012f858: Export the Effect-native core at the `@sealant/sdk/effect` subpath. Effect-end-to-end consumers get
  the contract-derived control-plane client as a service (`SealantApiClient` +
  `sealantApiClientLayer`), one operation effect per contract endpoint, the managed runtime
  (`makeSdkRuntime`), and the typed contract errors on the failure channel — instead of wrapping the
  Promise facade. The README's "will be reachable" promise is now true.
- 5cabebb: Typed record-event taxonomy. `@sealant/api-contracts` now exposes the payload schemas behind every
  recorded event kind (process, io, file, network, runtime, and loss events — the stored jsonb shape:
  uint64s as decimal strings, protocol enums as numbers) plus `decodeRecordEventPayload`, a total
  decoder that folds a wire `(kind, ref)` pair into a discriminated union and degrades to an `unknown`
  case instead of throwing. The SDK's `TimelineEntry` is now that discriminated union: switch on
  `kind` and `data` narrows to the typed payload, with `{ kind: "unknown", rawKind, data }` as the
  forward-compatibility case for kinds newer than the SDK. No new event kinds were added; a
  file-read/open event is noted as future work.
- 436546e: Deterministic exec in a workspace. New contract endpoint `POST /v1/workspaces/:id/exec` executes an
  ORDERED LIST of commands in the workspace, recorded as ONE run (a "check run") on the same run-exec
  pipeline as harness runs — every command executes in order regardless of exit codes (a nonzero exit
  is a check datum, e.g. `base fails · head passes · revert fails`), and the run completes iff every
  command executed and was recorded. SDK: `workspace.exec(argv, { cwd? })` returns
  `{ exitCode, stdout, stderr, run }`, resolving on nonzero exits and rejecting only when the
  execution machinery itself broke.

### Patch Changes

- Updated dependencies [0d2ce1c]
- Updated dependencies [5cabebb]
- Updated dependencies [436546e]
  - @sealant/api-contracts@0.5.0

## 0.4.0

### Minor Changes

- a551b17: Rename the product's core noun from `sandbox` to `workspace` across the public API and
  SDK. "Workspace" is the honest, industry-standard name for the live, disposable environment a
  harness works in — Sealant does not provide a hardened security sandbox, so the old name
  over-promised containment. The `run` and `harness` nouns are unchanged.

  Concretely, this changes web and API routes from `/sandboxes` to `/workspaces`, renames the SDK
  surface (`sealant.sandboxes` → `sealant.workspaces`, and the `sandbox` handle to `workspace`),
  switches the SSH username prefix from `sbx-` to `ws-`, adds a rename-only database migration for
  the workspace tables and columns, and renames the internal `@sealant/sandboxes` package to
  `@sealant/workspaces`.

### Patch Changes

- Updated dependencies [a551b17]
  - @sealant/api-contracts@0.4.0

## 0.3.1

### Patch Changes

- 2b90be5: Platform release: interactive-run telemetry ingest re-enabled (run-keyed) with honest
  head-loss accounting. No SDK surface changes — this release keeps the package versions in lockstep
  with the self-host images that actually record interactive sessions.
  - @sealant/api-contracts@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [bf3dc5e]
  - @sealant/api-contracts@0.3.0

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

### Patch Changes

- Updated dependencies [6234d20]
  - @sealant/api-contracts@0.2.0
