---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspace-scoped Docker in a Lambda MicroVM on every managed OS family, proven live (server-side;
the packages ride the release train). Each family's image carries the Docker engine and the packages
it needs when the blueprint asks for `tooling.services.docker`, nix included, which had no Docker
line at all. Three faults in the families' recipes, found by that proof and fixed for every runtime:
Docker Hub's `archlinux` image is x86_64 only, so an Arch image on ARM64 now starts from Arch Linux
ARM's signed rootfs, verified against the port's build key; the nix image has no FHS dynamic loader
path, so no native harness binary (codex, claude, opencode) could start on it, and its package layer
now links glibc's loader into `/lib` and `/lib64`; and a recent npm skipped opencode's postinstall,
which fetches its binary, so that install now allows it. The worker image copies every file of
`microvm-image/`, the Arch signing key among them.
