---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Sealant no longer stores the arguments a process, a run's command or a session was started with.
Arguments can carry secrets (a token a script writes, a file's bytes in base64, `env KEY=value`),
and redaction covers output and terminal input, never arguments. What is kept is the executable, the
argument count and each argument's length in UTF-8 bytes:

- A record's `processStarted` event keeps its executable, working directory and pid, adds `argCount`
  and `argLengths`, and its `args` is always empty. The timeline summary reads
  `exec sh (2 arguments not recorded)`.
- A run's `command` has an empty `args`, with `argCount` and `argLengths`.
- A session's `argv` holds only the program, with `argCount` and `argLengths`.
- A run's `recordDeletedAt` says when run-record retention deleted its record.

In the SDK, `RunCommand` gains an optional `argCount` (always set by `record.commands()`), and
`command` reads `opencode (2 arguments not recorded)`. A record written by an older control plane
still carries its arguments, and reads in full until the upgrade's migration rewrites it.

Rotate every secret delivered through arguments before this release, such as Mend's secret files.
Anyone with read access to the database, its dumps or its backups could read them, and rewriting the
rows cannot recall a copy already taken.
