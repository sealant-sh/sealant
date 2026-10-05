---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

The SDK surface for per-person homes (Mend ADR 0016):

- `create({ credentialsHome: { path, uid, gid } })` writes the launch's logins into that home
  instead of `$HOME` and the environment: Claude and Codex as their files, GitHub as
  `.config/gh/hosts.yml`, every file owned by `uid`:`gid`, the home made for them if it does not
  exist. The home is then held for the workspace's owner, as `workspace.credentials.put` holds it,
  and kept refreshed. No extra call: the launch writes the files itself.
- `exec(argv, { user })` and `sessions.open(argv, { user })` ask for a process to run as a Linux
  user (a name or uid); `user` is on `ExecWorkspaceRequest` and `CreateSessionRequest`. Until the
  workspace runtime can start a process as another user, the call is refused (`409`, code
  `user-unsupported`) and nothing starts; it never runs as the workspace's own user instead.
  `SessionConflictError` gains an optional `code`.
- An image's per-person capability (`personLayout`: `status`, `missing`, `runtime`, `acl`) is on
  every workspace read's `publishedImage`, on `launch.image` after `ready()` and from
  `workspace.image()`, and before a create from `workspaces.inspectImage(options)`
  (`POST /v1/workspaces/image`), which plans the spec as the build would and answers the latest
  image published for that plan.
