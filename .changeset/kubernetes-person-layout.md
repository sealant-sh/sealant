---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A capture source's `ownerMap` now runs on Kubernetes under runc, where each person's `sudo` works
and the image builder records the image probe the launch checks
(`features().kubernetesPersonLayout`). A per-person launch on an image with no readable probe now
fails with `owner-map-unverified` instead of `owner-map-unsupported`.
