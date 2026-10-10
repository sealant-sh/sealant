---
"@sealant/sdk": minor
---

A workspace no longer reaches the cloud metadata address by default. On the Docker runtime, a
connection to 169.254.169.254, or to fd00:ec2::254 over IPv6, is refused at once from the workspace
and from every container its Docker service runs, for root and every other user in it; mirrors, the
object store, the control plane and the shared workspace network stay reachable. A workspace that
genuinely needs the address opts in with `workspaces.create({ network: { cloudMetadata: true } })`.
A gVisor (`runsc`) workspace cannot be guarded and launches only when it opts in. The worker's
`SEALANT_DOCKER_NETWORK_GUARD_IMAGE` replaces the pinned busybox it uses to add the routes.
