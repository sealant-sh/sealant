---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A catalog for workspace packages (server-side; the packages ride the release train). Each package id
a blueprint may ask for now has an entry per managed OS family: the family's repository package
where there is one, or a pinned upstream release (one archive per architecture, its SHA-256 checked
before anything is unpacked) where there is not, plus the link where a repository installs a binary
under another name. Until now an id the family map did not know was handed to the package manager as
is, and Mend's default list only existed on Arch x86_64: Fedora 41 has no `mise` or `lazygit`,
Ubuntu 24.04 also lacks `uv` and `pnpm`, both call the GitHub CLI `gh`, and Arch Linux ARM lacks
`mise`. Every id in Mend's default list now installs on fedora, arch, ubuntu and nix, on x86_64 and
ARM64.

An id the catalog does not know is refused when the image is planned, and `POST /v1/workspaces`
refuses it as a 400 naming the id and the catalog, rather than failing minutes into a build. A
custom base image still takes any name its own package manager knows.
