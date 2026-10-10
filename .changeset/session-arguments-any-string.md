---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A session's arguments may be any string. `argv[0]`, the program, must still be non-empty with no
leading or trailing whitespace; every word after it is passed to the program as it was sent: empty,
whitespace-led or multi-line, so `["bash", "-lc", "\n echo hi"]` and `["git", "commit", "-m", ""]`
now open a session where both were refused. This applies to `POST /v1/sessions`,
`POST /v1/sessions/as-user` and the SDK's `sessions.open(argv)`, which checks the same rule before
it sends.

- Limits: at most 64 words (as before), 131,071 bytes per word and 1 MiB in all, counted in UTF-8
  bytes. 131,071 is the longest word `execve` takes on Linux with 4 KiB pages (`MAX_ARG_STRLEN` is
  128 KiB and counts the terminating NUL). A word with a NUL byte is refused, since no process
  argument can carry one, and so is a lone UTF-16 surrogate, which has no UTF-8 form.
  `@sealant/api-contracts` exports the limits as `SESSION_ARGV_MAX_WORDS`,
  `SESSION_ARGV_MAX_WORD_BYTES` and `SESSION_ARGV_MAX_TOTAL_BYTES`, the rule as
  `sessionArgvIssue(argv)` and `sessionArgvSchema`.
- A request any control plane route cannot decode (a body that is not JSON or not an object, a field
  missing or of the wrong type, a refused `argv`) answers `400` `RequestRefusedError`. Its `message`
  names where the request is wrong and what was expected, never a value it held. The
  `RequestRefusal` middleware is applied to the whole `ControlPlaneAPI`, so every route has it.
  `describeRequestIssue` words the reason. Before this, such a request got an empty `400`, and the
  server's request log, error reporters and tracing span quoted the rejected input: a session's
  arguments, an exec's command, a run's command.
- In the SDK, `sessions.open(argv)` throws `SealantError` `invalid_argv` with the same reason before
  it sends a refused argv, surfaces a control plane's `RequestRefusedError` with its reason, and
  explains an older control plane's empty `400`.
- If `sealantd` refuses to start the program, the session and its run are now marked failed. Before
  this, both were left running. If the answer to an open is lost instead, Sealant asks `sealantd`
  again: a program it reports becomes the session's leader, and one it cannot report about leaves
  the session open for a close to find and stop.
- Upgrade the control plane before the SDK. An older control plane refuses an empty or untrimmed
  argument with an empty `400` and logs the argument. An older SDK refuses such an argument itself.
- The arguments still reach `sealantd` as an argv array, never a shell string, and Sealant still
  stores only their count and lengths.
