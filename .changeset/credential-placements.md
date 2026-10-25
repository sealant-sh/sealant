---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A home's logins carry placement receipts. Each credentials home a put or a list answers has
`placements`: one receipt per login written there, with `placementId` (stable while a refresh moves
the login's revision), `accountId`, the `revision` of the account whose bytes were written, `login`
and `pinned`. A put takes `live`, the placement ids its running processes hold in that home; a
selection that differs from a live placement's leaves that file in place and answers it with
`pinned: true`. A receipt whose placement is no longer ready (archived, pruned, released) protects
nothing. `credentials.prune(home, live)` (`POST /v1/workspaces/:workspaceId/credentials/prune`)
removes every login of the home that is neither live nor the person's default, and answers no home
for one that holds nothing. The SDK sends `live` and calls prune only on a control plane that
reports `features().credentialPlacements`, and otherwise throws `credential-placements-unsupported`
before sending anything. A put without `live` behaves as before.
