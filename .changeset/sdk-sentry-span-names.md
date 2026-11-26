---
"@sealant/sdk": patch
---

SDK spans now read cleanly in Sentry. Each `sealant.sdk.<group>.<endpoint>` span carries
`sentry.op: sealant.sdk`. The HTTP request span under it carries the endpoint's route template in
`url.template` and a `sentry.description` such as `GET /v1/sessions/:sessionId/output`, so Sentry no
longer describes the request by its URL and the IDs in it.
