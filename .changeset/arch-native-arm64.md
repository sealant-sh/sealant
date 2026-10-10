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

On Apple silicon and other arm64 hosts, an existing Arch workspace switches from emulated x86_64 to
native aarch64 at its next launch. Dependencies with native modules that were installed under
emulation in existing worktrees (`node_modules`, `.venv`, `target/`) are x86_64 builds: reinstall
them (`pnpm install`, `uv sync`, …). The first Arch build on such a host downloads the Arch Linux
ARM rootfs from `os.archlinuxarm.org` (about 300 MB), outside any registry mirror.

Every image is planned for the platform it runs on, and the plan hash covers it, so an amd64 image
is never reused on arm64. Plan hashes change once, and every image is built again on its next launch
(on amd64 from the layer cache: the Containerfile is unchanged). The platform is the Docker daemon's
architecture; on Kubernetes, the one the workspace node selector names, else the worker's node's.
`SEALANT_WORKSPACE_IMAGE_PLATFORM` (`linux/amd64` or `linux/arm64`) pins it for the API and the
worker; the Helm chart sets it on both from `workspaces.imagePlatform` or from the arch
`workspaces.nodeSelector` selects. Workspace Pods and image build Jobs select nodes of that
architecture, build Jobs run in the workspaces' node pool, and a build Job no node can take fails
after five minutes instead of waiting out the build's bound. A custom base image is built for the
platform its manifest offers, as before.
