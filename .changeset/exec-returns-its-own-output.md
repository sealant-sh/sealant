---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

`workspace.exec()` returns the output of the command it started, and no other. Before, when two
execs overlapped in one workspace, one of them could be handed the output of sealant's own reading
of the other's changes instead of its own, with the right exit code (SLNT-956). `workspace.exec()`
now picks the process the run started: the one whose timeline entry carries the run's id. A run's
timeline entries carry `executionId` on the wire (`timelineEntrySchema`), the execution the daemon
stamped on the event; it is optional, and a client that does not know it ignores it.
