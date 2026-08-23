---
"@sealant/sdk": patch
---

Session attach, SSE output streams, and workspace port forwards now always send the `ownerUserId` assertion in the URL.
Previously it was sent only for host-local (no API key) clients, so a service-principal client
opening the attach WebSocket was rejected with "ownerUserId is required when authenticating as a
service principal."
