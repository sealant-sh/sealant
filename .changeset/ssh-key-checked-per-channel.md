---
"@sealant/api-contracts": patch
---

`GET /v1/workspaces/:id/ssh-target` takes an optional `x-sealant-ssh-key-fingerprint` header: when
the gateway names the key a connection logged in with, the API answers only while that key is still
registered to the principal, and echoes it as `sshKeyFingerprint`. Removing a key now ends the
connections opened with it.
