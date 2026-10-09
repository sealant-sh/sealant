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

- Limits: at most 64 words (as before), 128 KiB per word (Linux's `MAX_ARG_STRLEN`) and 1 MiB in
  all, counted in UTF-8 bytes. A word with a NUL byte is refused, since no process argument can
  carry one. `@sealant/api-contracts` exports them as `SESSION_ARGV_MAX_WORDS`,
  `SESSION_ARGV_MAX_WORD_BYTES` and `SESSION_ARGV_MAX_TOTAL_BYTES`, with the rule itself as
  `sessionArgvIssue(argv)` and `sessionArgvSchema`.
- A refused `argv` answers `400` naming the word by its position and size, never its text. Before
  this, a refusal quoted the offending argument.
- Nothing else changes downstream: the arguments still reach `sealantd` as an argv array, never a
  shell string, and Sealant still stores only their count and lengths.
