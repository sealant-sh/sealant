---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Needs sealantd 0.15.1 (sealant-sh/sealantd#76): a daemon-only patch where tracked files win over
`.gitignore` and packs and staging survive a long ship. No new API surface;
`@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.1 and the baked daemon
default for workspace images, the MicroVM image and the Cloudflare bridge image is now
`ghcr.io/sealant-sh/sealantd:0.15.1`.
