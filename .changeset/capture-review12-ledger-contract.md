---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

During a rolling deploy, the control-plane release immediately before this one can no longer give up
an executor's removal while an earlier removal request, one the runtime may have accepted, has no
known outcome. That release already marked itself as a current writer of the capture ledger, so the
database let it through, though it didn't track each request's outcome. The marker now carries the
ledger contract's version, and the database holds every writer with another version to the older
rules. For every writer, the current one included, the database also refuses to end an issued
removal, other than as removed, while any request it sent has an unknown outcome.
