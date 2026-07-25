---
"@sealant/sdk": minor
"@sealant/api-contracts": patch
---

A real data plane for interactive terminals: `session.attach()` over one held WebSocket.

The request/response session verbs made every keystroke pay auth + DB lookups + a fresh short-lived
daemon connection (a `docker exec` spawn per event on the default transport), and output rode a
250ms journal poll — hopeless for an interactive terminal. New raw route
`GET /v1/sessions/:sessionId/attach` upgrades to a WebSocket, authenticates once, opens ONE daemon
control connection for the socket's lifetime, and bridges the daemon's reliable attach channel
(byte-exact replay from `?from=`, then live output) both ways. Binary frames are PTY bytes; text
frames are control JSON (`{"t":"resize",...}` up, `{"t":"end"}` down). The SDK exposes it as
`session.attach({from})` → `SessionAttachment` (`send`/`resize`/`output`/`closed`/`close`). The
existing `send`/`output` verbs remain the request/response control plane.
