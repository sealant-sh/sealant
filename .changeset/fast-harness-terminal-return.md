---
"@sealant/api-contracts": patch
---

Workspace images now bake sealantd 0.6.2, so an interactive harness returns the terminal as soon as
its session leader exits instead of waiting for helper processes that inherited the PTY. The
platform release also admits the matching 0.6.2 runtime SDK packages through the minimum-age gate.
