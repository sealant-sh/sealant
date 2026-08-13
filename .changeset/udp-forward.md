---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

UDP forwards: `workspace.forward(port, { protocol: "udp" })` opens a
connected-UDP forward in the workspace instead of a TCP stream — one frame
on the pipe is exactly one datagram, both directions (`?protocol=udp` on the
forward WS route; sealantd 0.7.0 underneath). TCP is unchanged and remains
the default.
