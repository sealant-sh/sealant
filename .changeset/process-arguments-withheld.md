---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A run's record no longer keeps the arguments a process was started with: they can carry secrets (a
token a script writes, a file's bytes in base64), and sealantd redacts output and terminal input,
never arguments. A `processStarted` event keeps its executable, working directory and pid, and adds
`argCount` and `argLengths` (each argument's length in UTF-8 bytes); `args` stays in the contract
and is always empty. The timeline summary reads `exec sh (2 arguments not recorded)`. In the SDK,
`RunCommand` gains `argCount`, and `command` reads the same way. A record written by an older
control plane still carries its arguments, and reads in full.
