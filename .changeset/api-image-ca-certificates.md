---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The api image bakes system CA certificates. The Codex CLI the codex inference engine spawns is a
native binary that validates TLS against `/etc/ssl/certs`, which `node:24-bookworm-slim` does not
ship — every codex exchange failed with "invalid peer certificate: UnknownIssuer" until the store
exists. Node's own TLS (and therefore the claude engine, which runs through the Agent SDK) was never
affected. No API surface changes; this release exists to rebuild the image.
