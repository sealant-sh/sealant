---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A seal must cover every unsaved answer an executor gave. Before, the control plane kept only the
latest status, so an older answer that arrived late could erase a newer failure and bring an old
seal back. The control plane now keeps every unsaved answer that no later answer covers. A stop's
`completion` attestation is `ignored` unless its seal covers all of them. An executor reads saved
only once each one is covered by an answer or a seal.

A removal the runtime was asked to make no longer ends when its call fails with an unknown outcome,
for example a lost reply. Until the outcome is known, `capture.status()` and `capture.flush()` keep
failing without asking the daemon, and the executor is not recovered. Only the runtime's own
refusal, the executor being gone, or the runtime's bound on the request having passed ends it. On
MicroVM that bound is 19.5 minutes: the terminate calls are bounded and AWS accepts a signed request
only within 15 minutes of signing.

Retained executors are now recovered independently, the one whose runtime ends soonest first. Every
call of a recovery attempt is bounded, and only one attempt runs per executor at a time. The
deadline sweep starts an urgent recovery itself instead of waiting for the recovery sweep. It
reports a removal as under way only after the removal was issued.
