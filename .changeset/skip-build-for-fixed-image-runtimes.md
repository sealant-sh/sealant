---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A workspace on a runtime that boots its own image is no longer built an image it never runs. The
worker built and published a workspace image for every workspace before it chose the runtime, with
the host's Docker when no Kubernetes builder was configured. The Lambda MicroVM runtime boots a
registered image ARN and never reads that image, so on a control plane without a Docker daemon every
MicroVM workspace failed at the build, and on one with a daemon the blueprint's image setup commands
ran on the control plane's host to produce an image nothing booted.

A runtime adapter now says whether it runs the built image (`builtImage: "unused"` on MicroVM). The
worker selects the runtime first and, for such a runtime, skips the build and the publish: the job
succeeds with no builder and no published image recorded, and the launch carries none rather than an
invented one. Docker, Kubernetes and Cloudflare are unchanged and refuse a launch without a built
image by name. A workspace view already omits `publishedImage` when none was published, so a MicroVM
workspace's view no longer names an image it did not run. A blueprint no runtime supports is still
reported by the launch, with its build left succeeded.
