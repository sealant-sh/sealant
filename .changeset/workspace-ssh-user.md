---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace's SSH sessions run as its owner's own Linux user (Mend's per-person layout runs VS Code
Remote-SSH as the launcher's user, never root).

- A user's person is bound once: `POST /v1/users/:id/person { id, uid, home }` (owner-map id, a uid
  in 40001–49999, a home under `SEALANT_PERSON_HOMES_ROOT`). The same values again are a no-op; a
  different binding, or a person id or uid another user holds, answers `409`
  (`person-binding-differs`, `person-taken`) and changes nothing. There is no rebind route.
- `sshAsOwner: true` on a create runs the sessions as that bound person. The create's capture owner
  map must give the person their bound uid, and its `credentialsHome` must be their bound uid and
  home; otherwise `403` (`WorkspaceSshOwnerRefusedError`). No caller names the user.
  `DELETE /v1/workspaces/:id/ssh-user` sets the sessions back to root, the only change after create.
- The SSH gateway starts every shell and command, and its disconnect-time working-tree capture, as
  that user, on a `sealantd` that reports `exec.user`, and refuses the session otherwise rather than
  run it as root. It asks who for every new session channel, so a change reaches a connection
  already open. `GET .../ssh-target` always states `sessionUser` (`null` for root), and the gateway
  refuses an answer without it. SFTP is refused for such a workspace until the pinned `sealantd`
  runs it as the user.
- SDK: `users.bindPerson()`, `create({ sshAsOwner })`, `workspace.sshAsRoot()`,
  `features().workspaceSshUser` and `features().personBinding`. A create with `sshAsOwner` is
  refused (`ssh-user-unsupported`) with nothing sent to a control plane without the feature.
