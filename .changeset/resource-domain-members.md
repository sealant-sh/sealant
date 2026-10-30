---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Resource domain members. `POST /v1/resource-domains/:resourceDomainId/members/:userId/grant` and
`/revoke` record the application's decision about one person, and
`GET /v1/resource-domains/:resourceDomainId/members` lists every decision, revoked ones included.
Each decision carries `version`, the application's own number for its decision about this person,
rising with each decision it makes. Core writes it only over a lower version. The same version with
the same state is a repeat and answers the member unchanged. The same version with the other state,
or a lower one, gets `409` `ResourceDomainMemberVersionConflictError`, which quotes nothing the
request sent and carries the decision that stands as `current`. So a delayed grant never undoes a
newer revoke, whatever order decisions arrive in, and the application never reads before it writes.
A person who does not exist gets `404` `ResourceDomainPersonNotFoundError`, apart from a domain that
does not exist (`ResourceDomainNotFoundError`), whatever the version, even when deleted while the
decision is written. The routes take a service key, as ensure and get do, and `userId` is a
`PersonId`.

The SDK reaches these routes as `sealant.scopes`: `ensure({ key })`, `get(id)` and `actAs(id)`.
`actAs(id)` returns a `ScopeClient` for one scope, and its `members` are the only way to a scope's
members. It has no workspace, run, inference, credential, SSH key, access token or user method, so
calling one does not compile.
