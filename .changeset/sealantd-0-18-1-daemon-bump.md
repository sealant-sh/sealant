---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

sealantd 0.18.1 (daemon image only; the packages ride the release train). The released daemon image
now ships `sealantctl` beside `sealantd` and `socat` (sealant-sh/sealantd#94). The MicroVM image
builder copies it into every workspace image, because the in-VM agent runs
`sealantctl capture flush` in the platform's suspend and terminate hooks. Against 0.18.0 that copy
fails and no MicroVM image builds. The baked daemon default for workspace images and the Cloudflare
bridge image is now `ghcr.io/sealant-sh/sealantd:0.18.1`, and `@sealant/runtime-client` and
`@sealant/runtime-protocol` move to `^0.18.1`. No daemon behaviour changed.
