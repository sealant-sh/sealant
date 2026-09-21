---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

An Arch image build fails at the package step when pacman cannot install a package (server-side;
the packages ride the release train). The step was rendered as `pacman -Syu && pacman -S … &&
pacman -Scc || true`, so the `|| true` meant for the cache clean covered the whole chain: a package
pacman could not find passed the step with nothing installed, and the build died steps later on a
missing `npm`, with the real cause buried in the log. Seen on Arch Linux ARM on 2026-09-21, where
`mise` is not packaged. The `|| true` now covers the cache clean alone.
