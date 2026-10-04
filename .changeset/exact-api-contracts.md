---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

`@sealant/sdk` depends on the exact `@sealant/api-contracts` version it was published with, not a
caret range. The two are versioned together, and a caret on a prerelease (`^0.39.0-next.9`) would
accept any later prerelease of the contract.
