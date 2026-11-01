---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`scope.workspaces.link(workspaceId, { worktreeKey, aliases })` takes a map from alias to the level
the workspace reaches it at, `"project"` or `"worktree"`. With a map, the workspace reaches only
what it names: `{ mail: "worktree", db: "project" }` reaches the worktree's own `mail` and the
project's `db`, so a project and a worktree instance can share an alias without both answering to
it, and an alias left out is not reached at all. Without a map, a link reaches every project
instance and its worktree's own, as before. Each call replaces the previous map, and an attachment
the new map leaves out is removed in the same call. The answer carries the map, or null.
