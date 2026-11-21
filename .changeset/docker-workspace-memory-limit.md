---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Docker workspaces now run with a memory limit, so one workspace can no longer use all of the host's
memory and stop everything on it. A workspace container gets half of the Docker host's memory (at
least 2 GiB, at most 16 GiB) and its Docker service a quarter (at least 1 GiB, at most 8 GiB), with
swap held at the same figure; at the limit the kernel stops a process inside that workspace.
Workspace containers are also the host's first choice when the host as a whole runs out. Operators
set `SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT` and `SEALANT_DOCKER_SERVICE_MEMORY_LIMIT` to `auto`,
`none` or a size such as `4g`.
