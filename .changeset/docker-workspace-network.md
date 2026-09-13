---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Docker runtime: `SEALANT_DOCKER_WORKSPACE_NETWORK=<name>` attaches every workspace container to an
existing Docker network (`--network <name>`), so a workspace resolves sibling Compose services — a
session channel, a bucket — by name without publishing them on the host. With the workspace Docker
service on, the container joins the shared network beside its sidecar network at creation (Docker
Engine 25+). Every workspace container also gets `--add-host host.docker.internal:host-gateway`.
