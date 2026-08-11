---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Allow the self-host API to open persisted workspace control sockets by mounting the socket directory
read-only and using sealantd's required root peer identity, while dropping all Linux capabilities
and forbidding privilege escalation.
