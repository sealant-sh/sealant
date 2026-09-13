---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A `microvm` runtime adapter id: workspaces can now run on AWS Lambda MicroVMs (one Firecracker VM
per workspace, driven with the Lambda MicroVMs API and reached through the VM's authenticated
inbound endpoint). Workspace reads report `runtime.adapter: "microvm"` for such workspaces, and
blueprints may request `target.runtime.family: "microvm"`. Nothing changes for Docker, Kubernetes or
Cloudflare deployments; a deployment registers the adapter only when the `SEALANT_MICROVM_*`
environment is configured.
