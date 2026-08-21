---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Pipe-mode sessions: `workspace.sessions.open(argv, { mode: "pipe" })` (and `POST /v1/sessions` with
`mode: "pipe"`) starts the leader with plain stdio pipes and no controlling terminal — the shape for
processes that speak a byte protocol over stdin/stdout, such as `codex app-server` or
`claude --print --input-format stream-json`. `send` feeds stdin, `output`/`attach` carry stdout
byte-exact with the same replay-from-sequence semantics as PTY sessions, stderr is recorded as
diagnostics only, and `resize` is rejected. Sessions report `mode`; the default stays `pty`.
Requires sealantd ≥ 0.11 in the workspace image.
