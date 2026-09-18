---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Needs sealantd 0.17.0 (sealant-sh/sealantd#86): the capture session channel and every presigned
object URL are dialled over HTTPS with a verified certificate, and never fall back. A plain-HTTP
channel is dialled only to loopback, or when the launcher states the network is private:
`source.transport.plaintext` on the capture source (`SEALANT_CAPTURE_ALLOW_PLAINTEXT` in the
workspace), which this release already sends. A private CA for the channel or the object store rides
`source.transport.channelCaPem` / `objectCaPem`. **Behaviour change:** a launcher that reaches its
channel over plain HTTP on a private network without sending `transport: { plaintext: true }` now
gets a workspace that refuses to boot, with the reason in its log. No new API surface here:
`@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.17.0, and the baked daemon
default for workspace images, the MicroVM image and the Cloudflare bridge image is now
`ghcr.io/sealant-sh/sealantd:0.17.0`.
