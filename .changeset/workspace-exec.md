---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Deterministic exec in a workspace. New contract endpoint `POST /v1/workspaces/:id/exec` executes an
ORDERED LIST of commands in the workspace, recorded as ONE run (a "check run") on the same run-exec
pipeline as harness runs — every command executes in order regardless of exit codes (a nonzero exit
is a check datum, e.g. `base fails · head passes · revert fails`), and the run completes iff every
command executed and was recorded. SDK: `workspace.exec(argv, { cwd? })` returns
`{ exitCode, stdout, stderr, run }`, resolving on nonzero exits and rejecting only when the
execution machinery itself broke.
