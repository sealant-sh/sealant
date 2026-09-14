---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Needs sealantd 0.15.2 (sealant-sh/sealantd#78, #79): a daemon-only patch where the orphan reaper no
longer reaps the daemon's own children, so `capture.flush` stops failing with
`No child process (os error 10)` on 4–33% of flushes under load, and a byte-quota refusal is
terminal instead of retried forever. No new API surface; `@sealant/runtime-client` and
`@sealant/runtime-protocol` move to 0.15.2 and the baked daemon default for workspace images, the
MicroVM image and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.15.2`.
