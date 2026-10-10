---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace's SSH sessions run as its owner's own Linux user (Mend's per-person layout runs VS Code
Remote-SSH as the launcher's user, never root). `sshAsOwner: true` on a create takes the uid of the
spec's `credentialsHome`, the home Core writes the owner's logins to (40001–49999, never root); no
caller names the user, so an owner cannot pick another person's identity.
`DELETE /v1/workspaces/:id/ssh-user` sets the sessions back to root, the only change after create.
The SSH gateway starts every shell and command, and its disconnect-time working-tree capture, as
that user, on a `sealantd` that reports `exec.user` and admits them as one of the executor's people,
and refuses the session otherwise rather than run it as root. It asks who for every new session
channel, so a change reaches a connection already open. `GET .../ssh-target` always states
`sessionUser` (`null` for root), and the gateway refuses an answer without it (an older API); the
API names a user only to a gateway that says it runs sessions as one. SFTP is refused for such a
workspace until the pinned `sealantd` runs it as the user. SDK: `create({ sshAsOwner })`,
`workspace.sshAsRoot()`, `features().workspaceSshUser`; a create with `sshAsOwner` is refused
(`ssh-user-unsupported`) with nothing sent to a control plane without the feature.
