---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Resource domain members. `POST /v1/resource-domains/:resourceDomainId/members/:userId/grant` and
`/revoke` record the application's decision about one person, and
`GET /v1/resource-domains/:resourceDomainId/members` lists every decision, revoked ones included.
Each decision carries `expectedVersion`, the member's version it replaces (0 for a person with no
decision yet), and writes the next one. Another version gets `409`
`ResourceDomainMemberVersionConflictError`, which quotes neither version, so a delayed grant never
undoes a newer revoke. Repeating the decision that wrote the current version answers it unchanged. A
person who does not exist gets `404`. The routes take a service key, as ensure and get do, and
`userId` is a `PersonId`.

The SDK reaches these routes as `sealant.scopes`: `ensure({ key })`, `get(id)`, `members.grant`,
`members.revoke` and `members.list`. `scopes.actAs(id)` returns a `ScopeClient` for one scope. It
has no workspace, run, inference, credential, SSH key, access token or user method, so calling one
does not compile.
