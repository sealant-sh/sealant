---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`worktreeId` is optional on the `capture` workspace source. A standby executor launched before its
worktree exists — to materialise the project base and a dependency cache, then be bound to a
worktree at claim — omits it; `SEALANT_CAPTURE_WORKTREE_ID` stays unset on every runtime (Docker,
Kubernetes, Cloudflare) and the daemon takes the worktree from the channel's plan answer.
