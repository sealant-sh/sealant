---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Add opt-in Docker named-volume workspace mounts through `SEALANT_DOCKER_VOLUME_MAPPINGS`.
Containerized applications can share selected worktrees, harness state, control sockets, and staged
launch files with sibling workspaces without host-directory binds. Existing SDK mount, standby, and
additional-mount inputs retain their path-based contract; the deployment maps canonical paths to
existing named volumes and subdirectories. Strict mode validates mappings and source directories,
requires Docker API 1.45 or newer, and never falls back to host binds. Legacy bind mode is
unchanged.
