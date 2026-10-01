---
"@sealant/sdk": minor
"@sealant/api-contracts": patch
---

pi is a harness (`pi()`, harness id `pi`), and every workspace image now carries all four agent
CLIs: Claude Code, Codex, opencode and pi. opencode was installed only into an opencode blueprint's
own image; it is baked now, so a standby or a shell workspace can run it too. pi is installed from
its release binary for the machine (x64 or arm64), checked against the release's SHA256SUMS, so it
needs no Node: its npm package wants Node 22.19 or newer, which Ubuntu 24.04 does not have.
