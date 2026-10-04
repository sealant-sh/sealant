---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A run's changes say whether they were read. `GET /v1/runs/:runId/changes` answers `available` and,
when it is `false`, `unavailableReason`: the run has not ended, or reading its working tree failed.
The SDK's `run.changes` carries both. Until now a failed reading came back as an empty diff and no
files, which read as "nothing changed". A control plane older than the field answers without it, and
the SDK reads that as available.
