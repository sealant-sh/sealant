---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

`workspace.exec()` reads its run every 25 ms for the first half second, then waits twice as long
each time, from 50 ms up to 250 ms until 2 s and up to 500 ms after that. Doubling from 25 ms read
it at 25, 75, 175 and 375 ms, so an exec that ended at 80 ms was seen at 175 ms; it is now seen
within about 25 ms of ending.

A read of the exec's run that is refused (429), fails on the control plane (5xx) or is lost in
transport is read again, after the `Retry-After` the answer named or a backoff from 100 ms to 2 s,
for up to a minute. One failed read used to reject the exec while its run went on. Every read error
`exec()` rejects with names the run. `GET /v1/runs/:runId` declares `BudgetExceededError`, so a 429
from the request budget decodes as one.
