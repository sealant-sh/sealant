---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspace images bake `bubblewrap` alongside the Codex CLI. Codex's Linux sandbox wants a system
`bwrap` and printed "Codex could not find bubblewrap on PATH … will use the bundled bubblewrap" on
every launch without it — the first thing every new workspace showed. The prerequisite now travels
with the harness integration on every family (fedora, arch, ubuntu, nix), so the banner is gone and
Codex sandboxes with the distro's `bwrap`. Image plan hashes change, so existing workspace images
rebuild once.
