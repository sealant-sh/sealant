---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

`packages.resolvePackage` answers from the workspace build's own package catalog, so an id resolves
as supported on a family exactly when an image of that family installs it, on amd64 and arm64. It
used to answer from an older, shorter list: `bun`, `unzip`, `starship`, `direnv` and the three zsh
plugins fell through to Repology and came back with no `canonicalId`, and `pnpm`, `uv`, `mise` and
`lazygit` read unsupported on Ubuntu (and `mise` on Fedora), though the image installs them from npm
or a pinned release. A client that saves only catalog ids (Mend's Setup page) could not save its own
defaults. A catalog id is answered from the catalog before any cached answer, so a resolution cached
before the catalog knew the id no longer stands for its 30 days.
