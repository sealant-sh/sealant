---
"@sealant/api-contracts": minor
---

Resource domains: an owner that is a project, not a person. It never holds a login or a provider
credential and never runs a harness. `POST /v1/resource-domains` with `{ key }` ensures one, and
`GET /v1/resource-domains/:resourceDomainId` reads it. The key is `<application>:<name>` and global,
and a repeated or concurrent ensure answers the same domain (`created` is true once). Only a service
key reaches these routes: any other bearer gets the transport's `401`, and a deployment served
without authentication serves them as it serves every route. A body field the contract does not
declare is refused with `400` instead of being dropped. A domain id is `rdm:<uuid>`, and every
person field of the API (`ownerUserId`, `onBehalfOfUserId`, `userId`, and the SSH gateway's
`x-sealant-principal-id` and `principalId`) is now a `PersonId`, which refuses one with `400`
`RequestRefusedError` before any handler runs. `@sealant/api-contracts` exports `PersonId`,
`isResourceDomainId`, `RESOURCE_DOMAIN_ID_PREFIX` and the resource domain schemas. The SDK does not
call these routes yet.
