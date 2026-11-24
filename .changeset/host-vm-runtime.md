---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Add `host-vm` to the runtime families: a workspace on a Linux server with KVM can run as its own
microVM. `workspaces.create({ runtime: "host-vm" })` asks for it, and a workspace's `runtime.kind`
can now read `host-vm`. A deployment launches it only once its worker has the host VM runtime and
its egress proxy configured; until then such a create is refused.
