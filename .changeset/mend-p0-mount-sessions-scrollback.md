---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Mount-sourced workspaces, first-class interactive PTY sessions, scoped access tokens, and
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
  process loss, and a session re-fetched by id from any workspace handle supports `send()`
  (string or bytes), `resize()`, `signal()`, `status()` (with the output high-water cursor), and
  `close()`. New control-plane endpoints under `/v1/sessions`, including an SSE live tail
  (`/v1/sessions/:id/output/stream`).
- **Byte-exact resumable output**: session output is recorded redacted and sequence-keyed;
  `session.output({ from })` replays exact history and continues into the live tail, resumable
  after any disconnect via `lastChunk.sequence + 1n`. `GET /v1/runs/:id/scrollback` gains
  `fromSequence`/`limit` range reads and a `pty` stream for interactive runs.
- **Scoped access tokens**: `sealant.accessTokens.create({ scopes, workspaceId?, ttl? })` mints
  bearer tokens over three scopes — `session:read` (stream/status), `session:input`
  (input/resize/signal), `workspace:exec` (open terminals) — enforced on the session surface, so
  a read-stream token can stream but is rejected for input and exec.
- **Server-side run commands**: run invocations for built-in harnesses are constructed by the
  control plane (persisted on the run), so `workspaces.get(id)` handles can start harness runs;
  an explicit client command remains the `customHarness()` escape hatch.
- **Correlation metadata**: opaque `metadata` bags accepted at run and session creation, stored
  verbatim and echoed on reads.
- sealantd image pin bumped to 0.6.0 (mount boot contract, durable PTY session journal, file
  events on by default).
