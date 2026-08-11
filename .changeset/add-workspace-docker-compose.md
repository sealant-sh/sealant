---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Include the Docker Compose CLI plugin in workspace images whenever the workspace-scoped Docker
service is enabled, so `docker compose` works against the workspace's disposable daemon.
