---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Per-user identity for products that own their own login.

- **Service principals.** `SEALANT_SERVICE_KEYS` (API) closes the control plane: every `/v1` request
  must carry a service key as a bearer (may assert any `ownerUserId`) or, on the session surface, a
  scoped user access token. Unset keeps the open loopback-only model. Public routes (`/healthz`,
  `/readyz`, `/openapi.json`, `/docs`) and the gateway routes are unaffected.
- **Users endpoint.** `POST /v1/users` upserts a user by email and `GET /v1/users/:userId` reads one
  — the provisioning path for a product that maps each of its users to a Sealant user.
- **Owner scoping on reads.** `GET /v1/workspaces/:id` and the `GET /v1/runs/:id` family accept an
  optional `ownerUserId` query and answer 404 when it does not match; the SDK always sends it,
  closing the by-id reads that previously leaked across owners.
- **SDK.** `SealantConfig.ownerUserId` (one client per user; overrides `SEALANT_OWNER_USER_ID`),
  `sealant.users.{ensure,get}`, and `sealant.connectedAccounts.{list,connect,disconnect}`; the
  matching `/effect` operations and contract errors are exported.
