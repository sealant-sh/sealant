---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Resource domain budgets. A domain's budget caps CPU (millicores), memory and storage (bytes). The
caps are ceilings on what the domain's objects hold, not measurements, and zero allows nothing.
`POST /v1/resource-domains` takes an optional `budget` that a new domain starts with. It never
changes an existing domain's: naming another one gets `409` `ResourceDomainBudgetDiffersError`,
which carries the domain's `resourceDomainId` and its budget's `revision`.
`GET /v1/resource-domains/:resourceDomainId/budget` reads the budget and what the domain holds of
it, in one snapshot: per dimension, the `limit`, what is `used` (confirmed to exist) and `reserved`
(not yet confirmed), and a `warning` of `80-percent`, `95-percent` or `full` once `used + reserved`
reaches that share of the limit. Storage also reports what archived volumes (`archived`) and backups
and snapshots (`protection`) hold; both count against the one storage allowance. Nothing creates a
domain's objects yet, so `used` and `reserved` read zero. `PUT …/budget` replaces the budget, given
the `revision` the caller read, and answers the budget it wrote; a change made since gets `409`
`ResourceDomainBudgetRevisionConflictError` and changes nothing. `RESOURCE_DOMAIN_BUDGET_DIMENSIONS`
names the dimensions.

The SDK reaches the budget as `sealant.scopes.actAs(id).budget.get()` and
`.budget.set({ cpuMillicores, memoryBytes, storageBytes, revision })`, and
`sealant.scopes.ensure({ key, budget })` takes the starting budget.
