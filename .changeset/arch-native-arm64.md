---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Arch workspaces run natively on arm64 Docker hosts and Kubernetes nodes. Docker Hub's `archlinux`
image is amd64 only, so an Arch image was built for amd64 everywhere and ran under emulation on
arm64 (Rosetta on Apple silicon, QEMU elsewhere). On arm64 it now starts from Arch Linux ARM's
rootfs, verified against the port's build key: the same stages the MicroVM images already used,
which now also drop the board kernel and firmware (1.3 GB) and lock the tarball's default accounts.
amd64 hosts build from `archlinux` as before. Fedora, Ubuntu and nix were already native.

Every image is planned for the platform it runs on, the Docker daemon's architecture or the worker's
node's, and the plan hash covers it, so an amd64 image is never reused on arm64. Plan hashes change
once, and every image is built again on its next launch. `SEALANT_WORKSPACE_IMAGE_PLATFORM`
(`linux/amd64` or `linux/arm64`) pins the platform for the API and the worker where they do not
share a machine with the Docker daemon.
