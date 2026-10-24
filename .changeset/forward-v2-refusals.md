---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace forward can now say why it did not open. The contracts describe a v2 forward route,
`GET /v1/workspaces/:workspaceId/forward/v2` with the subprotocol `sealant.forward.v2`: the server
accepts the WebSocket upgrade, then sends one text frame, either `ready` or `refused` with a
`reason`, a `message` and the HTTP `status` the refusal stands for. The reasons and their statuses
are one table, `FORWARD_REFUSAL_STATUS`. A browser or Node `WebSocket` can read this answer, which
it could not read from a refused upgrade. A client decodes any `reason`, so a refusal from a newer
Core keeps its status and message.

The SDK exports `ForwardDialError`, a `SealantApiError` whose `reason` is one of those reasons,
`unrecognized-refusal` (a reason newer than the SDK, kept in `wireReason`), `protocol-unsupported`
(the control plane predates the v2 route) or `transport-unavailable` (no answer could be read). Its
`status` is the one Core sent. `SealantApiError.name` is now typed `string`, so a subclass can name
itself. `workspace.forward` and its errors are unchanged; the v2 open is not public yet.
