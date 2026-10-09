---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace's SSH sessions run as the Linux user its owner names (Mend's per-person layout runs VS
Code Remote-SSH as the launcher's user, never root). `sshUser` on a create, and
`PUT /v1/workspaces/:id/ssh-user { ownerUserId, user }` (`null` for root), take a login name or a
decimal uid in 40001–49999, never root; the user need not exist yet. The SSH gateway then starts
every shell and command of the workspace's sessions as that user, on a `sealantd` that reports
`exec.user` and admits them as one of the executor's people, and refuses the session otherwise
rather than run it as root; SFTP is refused for such a workspace until the pinned `sealantd` runs it
as the user. The ssh-target answer names the user only to a gateway that says it runs sessions as
one. SDK: `create({ sshUser })`, `workspace.setSshUser(user | null)`, and
`features().workspaceSshUser`; both are refused (`ssh-user-unsupported`) with nothing sent to a
control plane without the feature.
