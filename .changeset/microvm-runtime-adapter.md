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

`workspace.capture.flush()` (`POST /v1/workspaces/:id/capture/flush`): a final capture, then
everything staged is shipped and registered on the session channel, answered with the daemon's
capture status (`pending`, `fenced`, byte and object counts). Synchronous over the control
connection, refused on workspaces that are not capture-sourced. Needs sealantd 0.14.0 in the
workspace image, which is now the baked default.
