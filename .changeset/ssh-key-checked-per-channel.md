---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Removing an SSH key ends the gateway connections opened with it. `GET /v1/workspaces/:id/ssh-target`
takes an optional `x-sealant-ssh-key-fingerprint` header: when the gateway names the key a
connection logged in with, the API answers only while that key is still registered to the principal
(else `401` `WorkspaceSshKeyNoLongerRegisteredError`, the one refusal on which the gateway ends a
connection), and echoes it as `sshKeyFingerprint`. The control plane reports this as
`features().sshKeyRemovalEndsConnections`, so a client can say whether removing a key ends what is
already open.
