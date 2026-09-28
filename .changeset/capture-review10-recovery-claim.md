---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A retained executor's recovery and a removal from another path can no longer overlap. Recovery
starts an executor only under its own live recovery claim. While that claim is live, no other path
can remove the executor; only the recovery attempt that holds the claim can. Another path decides
again once the claim is released or lapses.
