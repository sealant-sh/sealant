---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

During a rolling deploy, an older control-plane process can no longer remove an executor while an
answer that says its work is not saved is on record. The database already kept such answers for
newer processes, but an older process reads only the latest status, which can look covered by a
seal. The database now refuses an older process's removal while any unsaved answer is on record, and
the older process keeps the executor. Newer processes weigh those answers themselves and are not
affected.
