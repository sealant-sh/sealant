---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Bake every supported harness CLI into each workspace image (codex + claude-code; opencode installs
as an extra when a blueprint requests it), and inject `SEALANT_HARNESS_BANNER` /
`SEALANT_HARNESS_LAUNCH_COMMAND` at container launch instead of baking them as image ENV. Harness
choice now decides what launches, not what is installed — a shell in any workspace can open either
baked agent against the same files and state.
