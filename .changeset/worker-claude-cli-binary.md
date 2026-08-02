---
"@sealant/api-contracts": patch
---

The sealant-worker image now carries the Claude Agent SDK's vendored `claude` platform binary, so
the session keep-fresh sweeper's refresh ping actually runs in production (v0.11.0 shipped without
it; the sweeper's own logging caught the gap — "Native CLI binary for linux-x64 not found" — and
degraded safely to skipped-not-newer). The staging script is shared with the api image, and both
runtime images now assert at build time, per arch, that the binary resolves exactly the way the
bundle resolves it at runtime — a broken layout fails the image build, never the first
sweep/inference in production.
