---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Add `source.harnessHome` for capture-sourced workspaces. The optional executor-local directory is
validated, persisted in the workspace blueprint, sent to every runtime as
`SEALANT_CAPTURE_HARNESS_HOME`, and retained across cold materialization and standby replans. When
omitted, capture behavior is unchanged.
