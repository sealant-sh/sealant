---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

`workspace.forward(port, { host })`: the forward target grows from fixed loopback to a closed
workspace-private set — `127.0.0.1` (default) or `docker`, the workspace-scoped Docker sidecar's
network alias. Inner `docker compose` publishes its ports on that sidecar, so a database started by
compose is now reachable through the same forward surface. Never caller-arbitrary: the allowlist is
the SSRF boundary.
