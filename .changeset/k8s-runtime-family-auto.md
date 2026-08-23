---
"@sealant/sdk": minor
---

`workspaces.create` no longer pins the runtime target to Docker. The blueprint now carries
`target.runtime: { family: "auto", mode: "prefer" }`, so the deployment's default runtime adapter
decides — Docker on self-host (unchanged behaviour), Kubernetes when the control plane's worker is
configured for a cluster. Callers that genuinely need a specific runtime family can still say so
through the control-plane API's blueprint.
