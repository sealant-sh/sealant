---
"@sealant/api-contracts": minor
---

Accept `"cloudflare"` as a workspace runtime adapter id in the core API contracts. The id names the
Cloudflare Sandbox runtime family; deployments that do not register that adapter keep answering such
requests with the existing `unsupported-runtime` error.
