---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Declare typed request budget errors on every control-plane endpoint and preserve optional admission
refusal metadata. Service-key requests now have independent owner and ownerless allowances under a
fixed key ceiling, with reserved capacity for interactive requests.

Default each service-key owner's allowance to 6,000 requests per minute, with 4,800 available to
normal traffic under the existing 20% interactive reserve. Keep the ownerless allowance at 6,000 and
the fixed whole-key ceiling at 12,000. Request counters remain in memory per API process.

Expose `SealantBudgetExceededError` with the budget, threshold, retry delay and optional refusal
fields. Send request-local priority for session input and workspace control. Preserve budget
metadata on forward refusals and avoid polling immediately after a session stream budget refusal.
Admission metadata covers only the refused HTTP request, including when a composite operation
already completed an earlier write.
