---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A rolling deploy can no longer weaken the capture ledger's guarantees. While older and newer
control-plane processes run side by side, the database now enforces the ledger's rules for writes
from older processes. An older process that replaces a status keeps the replaced answer on record if
the work was not saved, so an earlier seal cannot stand again. An older process can no longer give
up a removal it already issued; only the removal's outcome ends it. It can no longer send a removal
again after the evidence changed, or authorize one while a recovery attempt holds the executor. It
also no longer finds a claimed executor due for recovery, so it cannot start a second recovery
beside the first. Apply the migration before starting the new processes.
