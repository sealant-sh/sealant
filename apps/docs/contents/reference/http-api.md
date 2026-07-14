---
title: HTTP API
description:
  The Sealant control-plane HTTP API — base URL, the live OpenAPI docs, a resource summary, and a
  frank note on the current auth model.
---

The control plane is a single HTTP API. Everything the web app and the [SDK](/docs/reference/sdk) do
— create workspaces, register runs, read execution records, manage SSH keys, wire up GitHub — goes
through it. The contract is defined once (as an Effect `HttpApi`) and both the OpenAPI spec and the
live docs are generated from it, so the running install is always the source of truth.

## Base URL

On a default self-host the API is published on loopback:

```
http://localhost:4000
```

The host and port follow [`SEALANT_BIND_HOST`](/docs/reference/environment-variables) and
`SEALANT_API_PORT`. (Some older SDK comments mention `:8080` — ignore those; self-host uses
`:4000`.)

## Live docs and the spec

Rather than duplicate schemas here, read them from your running install — they can never drift from
the code:

- **Interactive docs (Scalar):** [`http://localhost:4000/docs`](http://localhost:4000/docs)
- **OpenAPI spec:** [`http://localhost:4000/openapi.json`](http://localhost:4000/openapi.json)

Point any OpenAPI client generator at `/openapi.json` to get typed clients, or browse `/docs` to try
requests interactively.

## Resources

The shipped resource groups and their operations:

| Group                    | Operations                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System                   | `GET /`, `GET /healthz`, `GET /readyz`, `GET /v1/system/setup-state`                                                                                                                                                                                                                                                                                                                                                                  |
| Packages                 | `GET /v1/packages/resolve?query=&targetOs=`                                                                                                                                                                                                                                                                                                                                                                                           |
| Workspaces               | `POST /v1/workspaces`, `POST /v1/workspaces/:workspaceId/exec`, `POST /v1/workspaces/:workspaceId/stop`, `POST /v1/workspaces/:workspaceId/restart`, `POST /v1/workspaces/:workspaceId/expire`, `PATCH /v1/workspaces/:workspaceId/name`, `GET /v1/workspaces`, `GET /v1/workspaces/:workspaceId`, `GET /v1/workspaces/:workspaceId/attempts`, `GET /v1/workspaces/:workspaceId/events`, `GET /v1/workspaces/:workspaceId/ssh-target` |
| SSH keys                 | `POST /v1/ssh-keys`, `GET /v1/ssh-keys`, `DELETE /v1/ssh-keys/:sshKeyId`, `POST /v1/ssh-keys/resolve-principal`                                                                                                                                                                                                                                                                                                                       |
| Connected accounts       | `POST /v1/connected-accounts`, `GET /v1/connected-accounts`, `DELETE /v1/connected-accounts/:connectedAccountId`, `POST /v1/connected-accounts/:connectedAccountId/mark-invalid`                                                                                                                                                                                                                                                      |
| Profiles                 | `GET /v1/profiles`, `GET /v1/profiles/:profileId/credential-bindings`, `PUT /v1/profiles/:profileId/credential-bindings`                                                                                                                                                                                                                                                                                                              |
| Runs / execution records | `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:runId`, `PATCH /v1/runs/:runId`, `GET /v1/runs/:runId/timeline`, `GET /v1/runs/:runId/events/:sequence`, `GET /v1/runs/:runId/scrollback`, `GET /v1/runs/:runId/loss`, `GET /v1/runs/:runId/changes`                                                                                                                                                                                  |
| Registries               | `GET /v1/registries/:registryId`, `GET /v1/registries/:registryId/ping`, `GET /v1/registries/:registryId/extensions`, `GET /v1/registries/:registryId/tags?repository=`, `GET /v1/registries/:registryId/manifest?repository=&reference=`                                                                                                                                                                                             |
| GitHub                   | `GET /v1/github/installations`, `GET /v1/github/installations/:installationId/repositories`, `POST /v1/github/installations/import`, `POST /v1/github/installations/:installationId/sync`, `POST /v1/github/webhooks`                                                                                                                                                                                                                 |

The execution record is read through the run endpoints: `/timeline` is the ordered event stream,
`/scrollback` returns byte-exact process I/O, `/changes` is the file diff, and `/loss` reports any
gaps. See [Execution records](/docs/concepts/execution-records) for what these mean.

Not yet part of the API: a repositories resource, artifact-bundle endpoints, outbound webhook
subscriptions, and API-token management. Do not build against them — they are not shipped. See
[What ships today](/docs/introduction/what-ships-today).

## Authentication

There is **no bearer-token authentication and no API-token system today.** This is the single most
important thing to understand about the current API.

- **The API does not authenticate requests.** There is no bearer-auth middleware enforcing identity
  on the resource groups. CORS permits an `Authorization` header, and the SDK can attach one, but
  nothing on the server verifies it.
- **Identity is passed in the payload.** User-scoped operations take an `ownerUserId` (or `userId`)
  directly in the request body or query string. The SDK defaults this to `usr_local` (override with
  `SEALANT_OWNER_USER_ID`). Whatever value you send is the owner the control plane attributes the
  work to.
- **This is a temporary model.** The `ownerUserId`-in-payload path is scaffolding that goes away
  once real authentication lands. Do not build durable authorization assumptions on it.
- **The exceptions are the internal SSH-gateway routes.** `POST /v1/ssh-keys/resolve-principal` and
  `GET /v1/workspaces/:id/ssh-target` require the shared `x-sealant-gateway-token`
  ([`WORKSPACE_SSH_GATEWAY_TOKEN`](/docs/reference/environment-variables)), and the SSH-target
  lookup also checks workspace ownership. These exist for the gateway, not for general clients.

Because the API trusts the `ownerUserId` you send, **treat network reachability as your only access
control.** Keep the API on loopback unless you have put your own authenticating proxy in front of it
— see [Beyond localhost](/docs/guides/beyond-localhost) and the
[security model](/docs/concepts/security-model).

Related: [SDK](/docs/reference/sdk) · [Environment variables](/docs/reference/environment-variables)
· [Runs and execution records](/docs/guides/runs-and-execution-records)
