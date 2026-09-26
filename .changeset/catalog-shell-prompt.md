---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Six more workspace package ids (server-side; the packages ride the release train): `starship`,
`zsh-autosuggestions`, `zsh-syntax-highlighting`, `zsh-history-substring-search`, `direnv` and
`eza`, on fedora, arch, ubuntu and nix. Each is the family's repository package where there is one.
Fedora 41 and Ubuntu 24.04 package neither `starship` nor `zsh-history-substring-search`: there
`starship` is its pinned 1.26.0 release and the plugin is its 1.1.0 tag, checked by SHA-256 and
installed to `/usr/local/share/zsh-history-substring-search/`. The reference page lists where each
plugin's `.zsh` file lands on each family.

`POST /v1/workspaces` keeps the package ids a request names. It used to rewrite them to one family's
package names (`python` to `python3`, `github-cli` to `gh`) after checking them against the catalog,
and the image planner, which takes catalog ids, then refused the rewritten names: every nix, Fedora
and Ubuntu workspace that asked for `python` or `github-cli` failed to build. The rewrite also
refused ids its own map lacked on a family (`mise` on Fedora), and dropped a requested version.
