---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

sealantd 0.18.2 (daemon image only; the packages ride the release train). Dotfiles `manager: auto`
picks stow only for a stow layout, so a home mirror (`.config/`, `.zshenv` beside plain directories)
is copied with its dot entries instead of stowed without them; `HOME` is set for every apply, and an
arm64 loader shim is included (sealant-sh/sealantd#96). The baked daemon default for workspace
images and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.18.2`, and
`@sealant/runtime-client` and `@sealant/runtime-protocol` move to `^0.18.2`.
