---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`workspace.credentials.put({ …, partial: true })` writes what the person has connected and reports
what they have not, in one call: a provider whose account is refused (`connected-account-missing`,
`connected-account-invalid` or `connected-account-unsupported`) is left out, its login is removed
from the home as `null` would remove it, and the result's `skipped` lists
`{ provider, reason, message }` for each, instead of the whole put rejecting. Every other refusal
still rejects. The put now always resolves with `skipped` (empty for a whole put); on the wire,
`partial` on the request and `skipped: [{ provider, code, message }]` on a partial put's answer.
