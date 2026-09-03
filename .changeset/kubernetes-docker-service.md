---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Workspace-scoped Docker on Kubernetes, and a create-time refusal where it cannot be served.
`services.docker` now works on Kubernetes installs whose operator enabled it
(`workspaces.docker.enabled`): the rootless daemon runs as a sidecar of a user-namespaced workspace
Pod, the workspace receives `DOCKER_HOST=unix:///run/docker/docker.sock`, and
`forward({ host: "docker" })` keeps resolving (to the Pod's loopback, where nested containers
publish). An install that cannot serve the service refuses `workspaces.create` synchronously with
`WorkspaceDockerServiceUnsupportedError` (HTTP 422, stable `code: "workspace-docker-unsupported"`) —
the consumer's capability probe, so a workbench can explain the gap beside its Docker switch instead
of surfacing a launch failure minutes later.
