---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The workspace package catalog knows `bun` and `unzip`. `bun` installs bun 1.4.2 on Fedora, Arch and
Ubuntu from its pinned release zip, checksummed before it is unpacked (the baseline build on x86_64,
so a CPU without AVX2 runs it), and links `bunx`; on nix it is the `bun` package. It adds about 80
MB to an image. A release may now ship as a `.zip`; the build installs `unzip` beside the release's
other tools only when one does.
