---
"@sealant/sdk": minor
---

Add `workspaces.create({ services: { docker: true } })`. Docker-enabled workspaces include the
client and connect to a disposable workspace-scoped rootless daemon without mounting the host Docker
socket.
