---
"@sealant/sdk": minor
---

Mount-sourced linked Git worktrees now automatically carry their shared Git metadata into the
workspace. The worktree remains the single public source and all repository data stays in
caller-owned host storage, while Git commands inside the workspace can follow the existing `.git`
pointer normally.
