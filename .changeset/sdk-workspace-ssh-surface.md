---
"@sealant/sdk": minor
---

Workspace SSH reaches the SDK: `sealant.workspaceSsh.info()` returns the deployment's gateway
connect coordinates (host, port, username prefix; null when no gateway is configured), and
`sealant.sshKeys.ensure/list/remove` manage the owner's SSH public keys — `ensure` is idempotent, so
consumers can offer a machine's key on every start. Together these let a product open a workspace in
an editor over SSH without any manual gateway or key configuration.
