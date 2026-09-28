---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A refused removal request no longer cancels an earlier one that may still act. Core now records
every request it sends to remove an executor, each with its own outcome. When a request sent again
is refused, only that request is settled. If an earlier request's outcome is still unknown, the
removal stays issued, so the executor is not observed or recovered. It stays that way until the
runtime no longer has the executor, or until the runtime's bound on every unknown request has
passed. Requests sent by older control-plane processes during a rolling deploy are recorded by the
database. Apply the migration before starting the new processes.
