---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A connected account reports how fresh its credential is. `ConnectedAccountSummary` gains a
`credential` object with `accessExpiresAt`, `refreshExpiresAt`, `lastRefreshAt` and
`lastRefreshOutcome` (`refreshed`, `fresh` or `failed`), and the SDK's `ConnectedAccount` carries it
through.

Every field is null when nothing was observed: a setup token has no expiry, a row connected before
this shipped has no stored one, and an account the keep-fresh sweeper has never touched has no
outcome. The numbers come from the non-secret metadata mirror and the account's own columns, so the
sealed payload stays sealed and a consumer gets an observation rather than a guess.

Two smaller changes make that possible: a Claude credentials file now records its
`refreshTokenExpiresAt` beside the access expiry it already recorded, and the keep-fresh sweeper
records what each sweep did. A consumer can now tell someone their grant expires on the 15th, or has
expired, before a harness fails to authenticate rather than after.
