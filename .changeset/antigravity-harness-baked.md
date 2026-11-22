---
"@sealant/sdk": minor
"@sealant/api-contracts": patch
---

Add Antigravity (`antigravity()`, harness id `"antigravity"`, executable `agy`) as a built-in
harness baked into every workspace image. The `agy` release binary for `x86_64` and `aarch64` is
pinned by version and verified against its SHA-512 checksum on its own image layer.
