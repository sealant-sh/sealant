---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Support the existing Docker service requirement on Lambda MicroVM workspaces when the operator
configures a separate Docker-capable image and pins the same image ARN/version on API and worker.
Ordinary workspaces keep their default image. The elevated variant uses guest-root Docker inside the
MicroVM, with a private Unix socket and disposable graph storage, not a host Docker socket or a
rootless sidecar.

The guest validates required-service readiness, prepares runtime directories after snapshot restore,
and reports Docker failure without losing the terminate hook's capture-flush opportunity. Docker
images now check daemon startup and cleanup during AWS image validation. This does not change the
fixed-image runtime model or make MicroVMs execute the workspace-profile OCI image.

The existing requirement to package the matching `sealantctl` alongside `sealantd` remains. Docker
activation requires a complete platform image; installing a client package alone is insufficient.
