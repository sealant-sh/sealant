---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

The SDK surface for per-person homes (Mend ADR 0016):

- `create({ credentialsHome: { path, uid, gid } })` writes the launch's logins into that home
  instead of `$HOME` and the environment: Claude (a setup token too) and Codex as their files,
  GitHub as `.config/gh/hosts.yml`, all in one write, every file owned by `uid`:`gid`, the home made
  for them if it does not exist. The home is then held for the workspace's owner, as
  `workspace.credentials.put` holds it, and kept refreshed; a launch delivered again writes again.
  Refused on the Cloudflare runtime.
- `exec(argv, { user })` and `sessions.open(argv, { user })` ask for a process to run as a Linux
  user (a name or uid); `user` is on `ExecWorkspaceRequest` and `CreateSessionRequest`. The SDK
  sends it only to a control plane whose index reports `features.processUser`, and refuses it
  client-side otherwise; until the runtime can start a process as another user, the control plane
  refuses it too (`409`, code `user-unsupported`). It never runs as the workspace's own user
  instead. `SessionConflictError` gains an optional `code`.
- An image's per-person capability (`personLayout`: `status`, `missing`, `runtime`, `acl`) is on
  every workspace read's `publishedImage`, on `launch.image` after `ready()` and from
  `workspace.image()`. `workspaces.imageKey(options)` computes, with no call, a key for the image a
  create would build; `workspaces.inspectImage(options)` (`POST /v1/workspaces/image`) reads the
  capability before a create, for a key not yet known.
