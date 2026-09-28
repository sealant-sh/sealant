---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspaces run sealantd 0.19.0. A capture flush now sends its kind (final or suspend), deadline and grace to the daemon, so a stop's final flush is a real FINAL, and every status field a 0.19.0 daemon reports (completion, the executor-origin stamp, the overdue step) reaches the SDK.
