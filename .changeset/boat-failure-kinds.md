---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A Boat workspace whose launch or image build failed because Boat refused, or did not answer, a call
now says why. `workspace.ready()` rejects with `SealantBoatError` (code still
`workspace_not_ready`), whose `boat` carries the kind from a closed set (`BOAT_FAILURE_KINDS`:
`key-refused`, `key-expired`, `permission-missing`, `sandbox-outside-key`, `organization-mismatch`,
`account-suspended`, `billing-required`, `running-limit`, `member-cap`, `rate-limited`,
`trial-restricted`, `no-machine`, `snapshot-allowance-full`, `no-answer`, `refused`), whether a
retry can succeed, and Boat's own code, message, request id, retry time and billing link. The
workspace's `error.boat` carries the same on the wire. A launch or build Boat refused for a reason
no retry can change is no longer retried.
