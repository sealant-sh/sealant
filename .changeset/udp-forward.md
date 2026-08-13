---
"@sealant/sdk": minor
"@sealant/workspaces": minor
"@sealant/api": minor
---

UDP forwards through the whole relay: `workspace.forward(port, { protocol:
"udp" })` opens a connected-UDP forward in the workspace instead of a TCP
stream — one frame on the pipe is exactly one datagram, both directions.
`?protocol=udp` on the forward WS route; daemon client and workspace image
pin bumped to sealantd 0.7.0. TCP behavior is unchanged and remains the
default.
