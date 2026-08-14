---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Custom base images: `workspaces.create({ baseImage: "node:22-bookworm" })` builds the workspace
image from any caller-supplied OCI reference instead of a managed OS family. Distro package installs
are skipped; the build overlays only the sealantd supervisor, the harness CLIs (npm), and a fully
static socat relay (vendored beside sealantd). The base-image contract (documented in the SDK
README): any Linux base on amd64/arm64 with a POSIX shell, node + npm for the harness CLIs, git for
clone/mount sources — each checked at build time with readable failures, including a shell-less
base. `packages` pass through verbatim to the base's own detected package manager
(apt/apk/dnf/pacman). `baseImage` and `os` are mutually exclusive.
