---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Docker workspaces can now each run on a network of their own instead of a shared one, so a workspace
no longer reaches the database, the object store or another workspace beside it. Set
`SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS` to a range (each workspace takes a `/28` of it) and every
workspace also refuses private, Tailscale, link-local, cloud metadata and Azure wireserver
addresses, and the host's own public addresses (`SEALANT_HOST_PUBLIC_IPS`). Operators open specific
private destinations with `SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS` and join their npm and Docker
mirrors to each workspace's network with `SEALANT_DOCKER_WORKSPACE_MIRROR_CONTAINERS`. Unset,
nothing changes.
