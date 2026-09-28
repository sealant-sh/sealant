---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A removal issued again after its first request's outcome was lost now checks the evidence again
right before it asks the runtime. Before, only the handover checked it, so an answer published
between the handover and the call could not stop a second request. Now that answer refuses the call.
The first request stays issued and keeps observation and recovery closed until the runtime shows its
outcome.
