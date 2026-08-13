# @sealant/api-contracts

## 0.15.0

### Minor Changes

- cfb6965: `workspace.forward(port, { host })`: the forward target grows from fixed loopback to a closed
  workspace-private set — `127.0.0.1` (default) or `docker`, the workspace-scoped Docker sidecar's
  network alias. Inner `docker compose` publishes its ports on that sidecar, so a database started by
  compose is now reachable through the same forward surface. Never caller-arbitrary: the allowlist is
  the SSRF boundary.

## 0.14.0

### Minor Changes

- 4a735c8: `workspace.forward(port)`: a raw TCP byte pipe to `127.0.0.1:port` inside the workspace, over one
  held WebSocket (`GET /v1/workspaces/:id/forward?port=N`, scope `workspace:exec`). The public surface
  for sealantd's existing forward primitive — protocol-agnostic, never recorded, host fixed at
  loopback. Nothing listening on the port is an HTTP 502 before the upgrade; a text `{"t":"eof"}`
  frame carries TCP half-close, which WebSockets lack natively.

## 0.13.5

### Patch Changes

- efcee92: Bake every supported harness CLI into each workspace image (codex + claude-code; opencode installs
  as an extra when a blueprint requests it), and inject `SEALANT_HARNESS_BANNER` /
  `SEALANT_HARNESS_LAUNCH_COMMAND` at container launch instead of baking them as image ENV. Harness
  choice now decides what launches, not what is installed — a shell in any workspace can open either
  baked agent against the same files and state.

## 0.13.4

### Patch Changes

- 6b91552: Allow the self-host API to open persisted workspace control sockets by mounting the socket directory
  read-only and using sealantd's required root peer identity, while dropping all Linux capabilities
  and forbidding privilege escalation.

## 0.13.3

### Patch Changes

- 145295d: Include the Docker Compose CLI plugin in workspace images whenever the workspace-scoped Docker
  service is enabled, so `docker compose` works against the workspace's disposable daemon.

## 0.13.2

### Patch Changes

- c245231: Keep API-backed workspace sessions on the persisted Unix control socket, including workspaces that
  do not enable SSH, so self-hosted API containers can supervise runs without a Docker CLI.

## 0.13.1

### Patch Changes

- bb4ae55: Declare Effect as a consumer-provided peer dependency so `@sealant/sdk/effect` and
  `@sealant/api-contracts` compose with the consumer's compatible Effect runtime instead of installing
  an incompatible second copy.

## 0.13.0

## 0.12.3

### Patch Changes

- bf5a55b: Forward the workspace mount allowlist and connected-account encryption key from self-host `.env`
  configuration into the API and worker containers.

## 0.12.2

### Patch Changes

- f605a8b: Workspace images now bake sealantd 0.6.2, so an interactive harness returns the terminal as soon as
  its session leader exits instead of waiting for helper processes that inherited the PTY. The
  platform release also admits the matching 0.6.2 runtime SDK packages through the minimum-age gate.

## 0.12.1

### Patch Changes

- 7ca347a: The sealant-worker image now carries the Claude Agent SDK's vendored `claude` platform binary, so
  the session keep-fresh sweeper's refresh ping actually runs in production (v0.11.0 shipped without
  it; the sweeper's own logging caught the gap — "Native CLI binary for linux-x64 not found" — and
  degraded safely to skipped-not-newer). The staging script is shared with the api image, and both
  runtime images now assert at build time, per arch, that the binary resolves exactly the way the
  bundle resolves it at runtime — a broken layout fails the image build, never the first
  sweep/inference in production.

## 0.12.0

## 0.11.0

### Minor Changes

- 8d86e05: Claude session credentials (`kind: "credentials-json"`) stay fresh instead of expiring whenever no
  workspace happens to run. Refresh was coupled solely to run-exec jobs; now the official Claude Code
  CLI/Agent SDK refreshes the session on three paths and the control plane persists the rotated file
  newest-wins on `claudeAiOauth.expiresAt`: inference runs the CLI against a private per-invocation
  `CLAUDE_CONFIG_DIR` holding the decrypted session file (refresh at point of use; setup-token
  accounts keep the env-var path), a worker sweeper refreshes any active session account expiring
  within 30 minutes every 15 minutes via a minimal one-turn exchange, and the workspace sync-back now
  also runs on every container teardown path (stop, expiry reap) so interactive sessions no longer
  lose rotated tokens. Every considered account logs exactly one sync outcome line. The compliance
  rule is unchanged: Sealant never calls Anthropic's token endpoint.

## 0.10.0

### Minor Changes

- cc7dddc: Claude connected accounts accept a second credential shape: the full Claude Code session credentials
  file (the JSON contents of `~/.claude/.credentials.json`) pasted by the operator. Session-file
  accounts (`kind: "credentials-json"`) are injected into workspaces as a
  `$HOME/.claude/.credentials.json` file with mode 600 — mirroring codex's auth.json — instead of the
  `CLAUDE_CODE_OAUTH_TOKEN` env var, present as the user's subscription (Anthropic treats setup tokens
  as API auth, which credit-gates some models interactively), and are synced back after runs
  newest-wins on `claudeAiOauth.expiresAt`. Existing `sk-ant-oat01-…` setup-token accounts keep
  working unchanged; reconnecting can switch shapes in place.

## 0.9.0

## 0.8.1

## 0.8.0

### Patch Changes

- 091ef5c: A real data plane for interactive terminals: `session.attach()` over one held WebSocket.

  The request/response session verbs made every keystroke pay auth + DB lookups + a fresh
  short-lived daemon connection (a `docker exec` spawn per event on the default transport), and
  output rode a 250ms journal poll — hopeless for an interactive terminal. New raw route
  `GET /v1/sessions/:sessionId/attach` upgrades to a WebSocket, authenticates once, opens ONE daemon
  control connection for the socket's lifetime, and bridges the daemon's reliable attach channel
  (byte-exact replay from `?from=`, then live output) both ways. Binary frames are PTY bytes; text
  frames are control JSON (`{"t":"resize",...}` up, `{"t":"end"}` down). The SDK exposes it as
  `session.attach({from})` → `SessionAttachment` (`send`/`resize`/`output`/`closed`/`close`). The
  existing `send`/`output` verbs remain the request/response control plane.

## 0.7.1

### Patch Changes

- e0aab44: Strip the create-payload `credentials` key from the workspace spec before it reaches the
  build job. The SDK folds `credentials` into the spec it sends; the api lowers it into
  `runtime.credentialRefs` but previously left the raw key in place, and the worker's strict
  blueprint schema rejected it — killing every `mount` + `credentials` create at
  `parseWorkspaceBlueprint` ("Unrecognized key: credentials"). Mount-sourced workspaces with
  connected-account credentials now build.

## 0.7.0

### Minor Changes

- 649d965: Mount-sourced workspaces, first-class interactive PTY sessions, scoped access tokens, and
  byte-exact resumable session output — the Mend agent-workbench P0 surfaces (plan §8.1.A/§8.1.B).
  - **Mount source**: `workspaces.create({ source: { kind: "mount", path } })` provisions the
    workspace from a caller-owned host directory bind-mounted as the working directory instead of a
    clone (sealantd ≥ 0.6.0). The path is caller-owned: writes persist across stop/restart/expiry
    and the platform never reprovisions or deletes it. Paths must be proper descendants of an
    operator-configured allowlist root (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`, enforced at the API,
    the launch adapter, and daemon boot). Credentials and dotfiles options compose unchanged;
    clone-based workspaces are unaffected.
  - **Interactive sessions**: `workspace.sessions.open(argv)` / `.get(id)` / `.list()` and a real
    `harness.session()`. Sessions are durable platform resources: the PTY survives handle and
    process loss, and a session re-fetched by id from any workspace handle supports `send()` (string
    or bytes), `resize()`, `signal()`, `status()` (with the output high-water cursor), and
    `close()`. New control-plane endpoints under `/v1/sessions`, including an SSE live tail
    (`/v1/sessions/:id/output/stream`).
  - **Byte-exact resumable output**: session output is recorded redacted and sequence-keyed;
    `session.output({ from })` replays exact history and continues into the live tail, resumable
    after any disconnect via `lastChunk.sequence + 1n`. `GET /v1/runs/:id/scrollback` gains
    `fromSequence`/`limit` range reads and a `pty` stream for interactive runs.
  - **Scoped access tokens**: `sealant.accessTokens.create({ scopes, workspaceId?, ttl? })` mints
    bearer tokens over three scopes — `session:read` (stream/status), `session:input`
    (input/resize/signal), `workspace:exec` (open terminals) — enforced on the session surface, so a
    read-stream token can stream but is rejected for input and exec.
  - **Server-side run commands**: run invocations for built-in harnesses are constructed by the
    control plane (persisted on the run), so `workspaces.get(id)` handles can start harness runs; an
    explicit client command remains the `customHarness()` escape hatch.
  - **Correlation metadata**: opaque `metadata` bags accepted at run and session creation, stored
    verbatim and echoed on reads.
  - sealantd image pin bumped to 0.6.0 (mount boot contract, durable PTY session journal, file
    events on by default).

## 0.6.0

### Minor Changes

- 6d1d72d: Workspace lifecycle close-out: `workspace.stop()`, `workspace.restart()`, and
  `workspace.expire()` are real end-to-end operations instead of `SealantNotImplementedError`
  rejections.

  - New control-plane endpoints: `POST /v1/workspaces/:id/stop` (async 202 — the worker removes the
    container and records the terminal `stopped` state), `POST /v1/workspaces/:id/restart` (async
    202 — a fresh launch from the same resolved spec, recorded as a new attempt), and
    `POST /v1/workspaces/:id/expire` (sets, clears, or triggers the workspace TTL).
  - `WorkspaceStatus` gains `"stopped"`, and workspace summaries/details expose `expiresAt`.
  - `createWorkspace` accepts an optional `ttlSeconds`; the SDK's `create()` accepts
    `ttl: "2h"`-style durations. Expired workspaces are stopped by the platform reaper.
  - SDK `stop()` blocks until the workspace reports `stopped`; `restart()` returns a fresh handle
    whose `ready()` gates on the new runtime; `expire({ in: "2h" | null })` sets or clears the TTL.

  Compatibility: adding `"stopped"` to the workspace status enum changes the wire contract — older
  published SDKs decode workspace responses against the previous five-value literal union and will
  fail to decode a stopped workspace. Upgrade the SDK together with the control plane.

## 0.5.0

### Minor Changes

- 0d2ce1c: Inference on connected accounts. New `inference` contract group:
  `POST /v1/inference/respond` runs short, tool-calling inference loops on the caller's own
  subscription — the server resolves the connected-account reference (same shape as workspace
  creation), decrypts, and invokes the OFFICIAL Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN`
  (never raw model-API calls on stored credentials, per the connected-accounts design's hard
  constraint). Caller-defined JSON-schema tools are exposed to the model verbatim; tool calls park
  server-side and the CALLER executes them, posting results back in a multi-turn session loop.
  Structured output rides the agent SDK's native json_schema output format. SDK:
  `sealant.inference.respond(...)` (new exchange or continuation) + `inferenceRespondOp` in the
  Effect core. Usage is attributed per account (`last_used_at`), and a live auth rejection marks the
  account invalid. Claude accounts only; Codex inference is a stated follow-up.
- 5cabebb: Typed record-event taxonomy. `@sealant/api-contracts` now exposes the payload schemas
  behind every recorded event kind (process, io, file, network, runtime, and loss events — the
  stored jsonb shape: uint64s as decimal strings, protocol enums as numbers) plus
  `decodeRecordEventPayload`, a total decoder that folds a wire `(kind, ref)` pair into a
  discriminated union and degrades to an `unknown` case instead of throwing. The SDK's
  `TimelineEntry` is now that discriminated union: switch on `kind` and `data` narrows to the typed
  payload, with `{ kind: "unknown", rawKind, data }` as the forward-compatibility case for kinds
  newer than the SDK. No new event kinds were added; a file-read/open event is noted as future work.
- 436546e: Deterministic exec in a workspace. New contract endpoint `POST /v1/workspaces/:id/exec`
  executes an ORDERED LIST of commands in the workspace, recorded as ONE run (a "check run") on the
  same run-exec pipeline as harness runs — every command executes in order regardless of exit codes
  (a nonzero exit is a check datum, e.g. `base fails · head passes · revert fails`), and the run
  completes iff every command executed and was recorded. SDK: `workspace.exec(argv, { cwd? })`
  returns `{ exitCode, stdout, stderr, run }`, resolving on nonzero exits and rejecting only when
  the execution machinery itself broke.

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

## 0.3.1

## 0.3.0

### Minor Changes

- bf3dc5e: `updateRun` accepts optional `diff` and `changedFiles` on terminal status transitions, so
  callers that observed a run's file changes (e.g. the SSH gateway finalizing an interactive
  session) can persist them alongside the status flip.

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
