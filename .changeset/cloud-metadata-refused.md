---
"@sealant/sdk": minor
---

A workspace no longer reaches the cloud metadata address by default. On the Docker runtime, a
connection to 169.254.169.254, or to fd00:ec2::254 over IPv6, is refused at once from the workspace
and from every container its Docker service runs. Users in the workspace cannot remove the refusal,
and the workspace runs without `NET_RAW`, so root gets no packet socket to send frames past it
(`ping` keeps working). The refusal is in place before the workspace is reported ready; steps
sealantd runs at boot on its own may start slightly earlier. Mirrors, the object store, the control
plane and the shared workspace network stay reachable. A workspace that genuinely needs the address
opts in with `workspaces.create({ network: { cloudMetadata: true } })`. A gVisor (`runsc`) workspace
cannot be guarded and launches only when it opts in. Workspaces already running when the worker is
upgraded keep the address until they stop.

The worker pulls the guard's image (a pinned busybox) when it starts and logs when it cannot;
`SEALANT_DOCKER_NETWORK_GUARD_IMAGE` replaces it with a reachable copy.
