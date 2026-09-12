---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The worker now keeps workspace images and build scratch bounded. Every build's scratch directory
(the Containerfile, plan and spec JSON, and the `docker save` tarball on registry installs) is
removed once the image is published or the build fails; before this each build left up to ~800 MB
under the worker's temp directory for good. An hourly retention sweep (`WORKSPACE_IMAGE_GC_ENABLED`,
`WORKSPACE_IMAGE_GC_INTERVAL_MS`, `WORKSPACE_IMAGE_RETAINED_PLANS`) deletes images no live workspace
launched from and no retained plan still needs — on the Engine store by image id, on a registry by
manifest — and removes build scratch older than six hours, so an upgrade reclaims what earlier
versions leaked. Stopping a workspace now removes its containers with their anonymous volumes; the
Docker sidecar used to leave one behind per workspace, and `docker volume prune` clears the ones
older installs accumulated.
