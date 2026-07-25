---
"@sealant/sdk": patch
---

Fix `session.attach`: the WS route now addresses the daemon's session id (and rejects
non-running sessions with a 409) instead of passing the control plane's id to the daemon.
