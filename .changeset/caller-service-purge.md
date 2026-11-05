---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Add explicit irreversible purge for stopped or archived caller-owned scope instances. Delete
retained service data, sealed env and provider resources, release budgets, and protect replacement
instances from stale purge retries with the expected instance id.
