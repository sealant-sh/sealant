---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A MicroVM termination is sent once and never retried inside the call. Before, the AWS SDK could
retry a termination whose first request reached the platform and lost its reply, and a refusal of
the retry was read as proof that nothing had been removed. The removal was then given up while the
first request could still act. A refusal now ends a removal only when it answers the call's only
request and is an error the platform documents as not acting. Any other failure leaves the removal
issued until the runtime shows its outcome.
