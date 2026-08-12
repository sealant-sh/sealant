---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

`workspace.forward(port)`: a raw TCP byte pipe to `127.0.0.1:port` inside the workspace, over one
held WebSocket (`GET /v1/workspaces/:id/forward?port=N`, scope `workspace:exec`). The public surface
for sealantd's existing forward primitive — protocol-agnostic, never recorded, host fixed at
loopback. Nothing listening on the port is an HTTP 502 before the upgrade; a text `{"t":"eof"}`
frame carries TCP half-close, which WebSockets lack natively.
