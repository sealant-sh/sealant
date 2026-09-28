---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Removing a capture executor is now an owned transition. Once the control plane authorizes the
removal on the evidence it holds, `capture.status()` and `capture.flush()` for that workspace fail
(500) without asking the daemon, until the removal is released or completes. After the executor is
removed they keep failing. Nothing received after that authorization can come too late to be
weighed. A status recorded anyway voids the removal, and the control plane decides again on the new
evidence.
