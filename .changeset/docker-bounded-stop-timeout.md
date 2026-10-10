---
"@sealant/sdk": patch
---

Restarting or upgrading Docker with a live workspace no longer hangs Docker. A Docker workspace
container's own stop timeout is now 60 s (`SEALANT_DOCKER_CONTAINER_STOP_TIMEOUT_SECONDS`), so
`systemctl stop docker` finishes inside systemd's 90 s stop timeout. Before, a capture workspace's
3600 s stop timeout was honored by dockerd's own shutdown, which outlasted systemd. systemd then
SIGKILLed dockerd and left the workspace running, and the next `systemctl start docker` waited for
it in "Restoring containers" for up to an hour before it started anything. A planned stop still
gives the full grace (`SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS`), now read from the container's
`sealant.stop-grace` label. A capture workspace that a Docker stop kills keeps its staging on its
disk and is recovered. Workspaces created before the upgrade keep their old stop timeout until they
stop.
