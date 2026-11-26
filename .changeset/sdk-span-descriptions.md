---
"@sealant/sdk": patch
---

An SDK call's span now says in words what the call does: Sentry shows
`sealant.sdk — get session output` rather than repeating the span's name beside its op. The span's
name (`sealant.sdk.sessions.get_session_output`) is kept in `code.function.name`, so a search for it
still finds the call.
