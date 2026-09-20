---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A Lambda MicroVM workspace boots the image built from its blueprint (server-side; the packages ride
the release train). Until now the MicroVM adapter booted one hand-registered image for every
workspace, so a blueprint's OS family, base image, packages and shell did nothing there, and the
container image the worker built for the run was never used.

Each runtime is now registered with the builder of the image it boots. MicroVM gets one of its own:
it takes the Containerfile planned for the blueprint, puts the in-VM agent on top, and has AWS's
managed image build run it under a build role. No recipe step runs on the control plane, and a
worker that serves only MicroVMs needs no Docker and no registry. One plan is one image, named
`sealant-ws-<plan hash>` and reused by every workspace with that plan. A cap
(`SEALANT_MICROVM_MAX_IMAGES`, 50) refuses to build past it and says so.

Breaking for a MicroVM deployment. `SEALANT_MICROVM_IMAGE_ARN`, `SEALANT_MICROVM_IMAGE_VERSION`,
`SEALANT_MICROVM_DOCKER_IMAGE_ARN` and `SEALANT_MICROVM_DOCKER_IMAGE_VERSION` are retired, and the
API and worker refuse to start while one is set. Set `SEALANT_MICROVM_BUILD_ROLE_ARN` (it now
enables the adapter) and `SEALANT_MICROVM_ARTIFACT_BUCKET` on the worker. Workspace-scoped Docker is
`SEALANT_MICROVM_DOCKER_ENABLED` on the API and worker, off by default, because such an image is
created with the `ALL` OS capability. A recipe step can obtain the build role's credentials, so give
that role `s3:GetObject` on the artifacts prefix and the two log actions only. The worker needs the
four `lambda:*MicrovmImage` actions, `iam:PassRole` on the build role, and `s3:PutObject` /
`s3:DeleteObject` on the prefix. `microvm-image/build-image.sh` and its Dockerfiles are removed.

Needs a sealantd release whose image ships `sealantctl` (sealant-sh/sealantd#94): the recipe copies
it from beside the daemon, for the capture flush in the suspend and terminate hooks.
