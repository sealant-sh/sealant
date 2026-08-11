---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Keep API-backed workspace sessions on the persisted Unix control socket, including workspaces that
do not enable SSH, so self-hosted API containers can supervise runs without a Docker CLI.
