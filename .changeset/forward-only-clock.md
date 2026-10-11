---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The SDK's waits and bounds (`ready()`'s readiness bound and image-build stall guard, `events()`,
`stop()`, `run.wait()`, `record.stream()`, `harness.run()`, `exec()`, dotfiles) run on a clock that
only moves forward (`performance.now()`). A wall clock stepped forward, as a VM's is when it is
resynced after its host slept (OrbStack, Docker Desktop), no longer counts as time waited: a build 8
minutes in was given up on as "no progress for 80 min" after a 72-minute step.

Stopping a workspace whose image build failed answers with its status (`failed`, or `cancelled`)
instead of refusing it as "still launching": nothing runs and nothing will. `stop()` resolves
`stopped` for such a workspace.
