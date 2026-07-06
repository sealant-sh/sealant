---
"@sealant/api-contracts": minor
---

`updateRun` accepts optional `diff` and `changedFiles` on terminal status transitions, so callers
that observed a run's file changes (e.g. the SSH gateway finalizing an interactive session) can
persist them alongside the status flip.
