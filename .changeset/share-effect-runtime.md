---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Declare Effect as a consumer-provided peer dependency so `@sealant/sdk/effect` and
`@sealant/api-contracts` compose with the consumer's compatible Effect runtime instead of installing
an incompatible second copy.
