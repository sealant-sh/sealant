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

| Group                    | Operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System                   | `GET /`, `GET /healthz`, `GET /readyz`, `GET /v1/system/setup-state`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Packages                 | `GET /v1/packages/resolve?query=&targetOs=`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Workspaces               | `POST /v1/workspaces`, `POST /v1/workspaces/image`, `POST /v1/workspaces/:workspaceId/exec`, `POST /v1/workspaces/:workspaceId/dotfiles`, `POST /v1/workspaces/:workspaceId/stop`, `POST /v1/workspaces/:workspaceId/restart`, `POST`, `DELETE` and `GET /v1/workspaces/:workspaceId/credentials`, `POST /v1/workspaces/:workspaceId/expire`, `PATCH /v1/workspaces/:workspaceId/name`, `GET /v1/workspaces`, `GET /v1/workspaces/:workspaceId`, `GET /v1/workspaces/:workspaceId/attempts`, `GET /v1/workspaces/:workspaceId/events`, `GET /v1/workspaces/:workspaceId/ssh-target` |
| SSH keys                 | `POST /v1/ssh-keys`, `GET /v1/ssh-keys`, `DELETE /v1/ssh-keys/:sshKeyId`, `POST /v1/ssh-keys/resolve-principal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Users                    | `POST /v1/users` (idempotent on email), `GET /v1/users/:userId` — identity rows for service principals acting on behalf of their own users                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Connected accounts       | `POST /v1/connected-accounts`, `GET /v1/connected-accounts`, `DELETE /v1/connected-accounts/:connectedAccountId`, `POST /v1/connected-accounts/:connectedAccountId/mark-invalid`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Profiles                 | `GET /v1/profiles`, `GET /v1/profiles/:profileId/credential-bindings`, `PUT /v1/profiles/:profileId/credential-bindings`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Runs / execution records | `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:runId`, `PATCH /v1/runs/:runId`, `GET /v1/runs/:runId/timeline`, `GET /v1/runs/:runId/events/:sequence`, `GET /v1/runs/:runId/scrollback`, `GET /v1/runs/:runId/loss`, `GET /v1/runs/:runId/changes`                                                                                                                                                                                                                                                                                                                                |
| Registries               | `GET /v1/registries/:registryId`, `GET /v1/registries/:registryId/ping`, `GET /v1/registries/:registryId/extensions`, `GET /v1/registries/:registryId/tags?repository=`, `GET /v1/registries/:registryId/manifest?repository=&reference=`                                                                                                                                                                                                                                                                                                                                           |
| GitHub                   | `GET /v1/github/installations`, `GET /v1/github/installations/:installationId/repositories`, `POST /v1/github/installations/import`, `POST /v1/github/installations/:installationId/sync`, `POST /v1/github/webhooks`                                                                                                                                                                                                                                                                                                                                                               |

The execution record is read through the run endpoints: `/timeline` is the ordered event stream,
`/scrollback` returns byte-exact process I/O, `/changes` is the file diff, and `/loss` reports any
gaps. See [Execution records](/docs/concepts/execution-records) for what these mean.

`/v1/workspaces/:workspaceId/credentials` holds people's logins in the homes of a running workspace,
one person per home.
`POST { ownerUserId, onBehalfOfUserId, home, uid?, gid?, claude?, codex?, github? }` writes copies
of that person's accounts (each an account id or name; `null` removes the provider) into `home`,
owned by the home's owner, mode `0600`, and keeps them refreshed there; GitHub is written as
`<home>/.config/gh/hosts.yml`. With `uid` and `gid` a home that does not exist yet is made for them.
A home holds one person's logins until it is released: a `POST` naming anyone else answers `409`
`home-held`. `DELETE ?ownerUserId=&home=` releases the home (its login files are removed), and
`GET ?ownerUserId=` lists the homes. A home is an absolute path, never under `/workspace`, reached
without a symbolic link (`409` `home-unusable` otherwise); `/root` takes only the workspace owner's
logins. Another write into the same home, or too many into the workspace at once, answers `409`
`home-busy`: nothing was done, try again. Only a service key may call them. A workspace with no
running executor answers `409` `workspace-not-running`. An account the person cannot name answers
`404` with `code` `connected-account-missing`, and one marked invalid or holding an unusable
credential `409` `connected-account-invalid`; both carry the account's `provider` (`claude`,
`codex`, `github`), so a caller can tell which login is missing without reading the message, and
nothing is written. A create's explicitly named account is refused the same way.

A create's `spec.runtime.credentialsHome` (`{ path, uid, gid }`) writes the launch's logins into
that home instead of `$HOME` and the environment (GitHub as `<home>/.config/gh/hosts.yml`), made for
that owner if missing, and records the home as the workspace owner's. A capture source's
`spec.sources.workspace.ownerMap` (`{ gid, worktreeUid, people: [{ id, uid }] }`) says who owns what
the daemon's restore writes: each person's saved directory (`<harnessHome>/people/<id>/`) theirs,
the worktree the group's, and, when it names anyone, an executor without no-new-privileges, so every
person's `sudo` works. It is checked at create (`400` with the reason): `gid` 40000, uids in
40001–49999, ids that are one directory name, no id or uid twice, at most 256 people; refused on
Cloudflare and Kubernetes (no person's `sudo` works under `allowPrivilegeEscalation: false`), and in
`runtime.env`, whose names must be environment variable names. The launch refuses it
(`owner-map-unsupported`, nothing started) on an image whose probe does not report
`restore.owner_map`. `POST /v1/workspaces/:id/capture/replan` takes `expectedOwnerMap` (`null` for
none) and answers `409` `owner-map-mismatch` on an executor launched with another map; the capture
status reports `ownerMap`. `POST /v1/workspaces/image { ownerUserId, registryId, spec }` answers,
before any create, the image plan the spec renders, the latest image published for it, and its
per-person capability (`personLayout`, also on every workspace read's `publishedImage`). Exec and
session requests take `user` (a Linux user name or uid); until the workspace runtime can start a
process as another user they answer `409` `user-unsupported` and start nothing.

`POST /v1/workspaces/:workspaceId/dotfiles { ownerUserId, onBehalfOfUserId, user, home, repository?, archives? }`
(service key only) applies a person's dotfiles into their home of a running workspace, as their
Linux user (`sealantd`'s archive unpacking and `copy` manager still run as root inside the home
until its fix lands), recording `onBehalfOfUserId` on the run: the sources of a create's dotfiles
(`repository: { url, ref?, manager?, bootstrap?, bootstrapCommand? }` cloned with no credential,
`https://` only, and a URL carrying one is a `400`; up to 4
`archives: [{ data, manager?, target?, bootstrap?, bootstrapCommand? }]`), the same applier, then
each tree's bootstrap (`./install.sh`) as the user. `user` must not be root (`400`), and `home` must
be its passwd home, never under `/workspace`. It answers `202` with a run (`harnessId` `dotfiles`)
once the archives are staged; the run's first `processStarted` is the bootstrap, started once every
file is applied, and the run ends with the bootstrap's exit code (`0` without one), or fails with
the daemon's words when the apply is refused or the bootstrap runs past 30 minutes. Nothing is
applied when it answers `409` `dotfiles-user-unsupported` (the workspace's `sealantd` cannot apply
as a user), `user-unknown`, `user-root`, `home-mismatch` (not the user's home), `home-unusable`
(missing, not theirs, or reached through a symbolic link), `home-held` (another person's logins are
held in the home) or `workspace-not-running`.

The registry group describes wherever workspace images live. With no registry configured (the
single-host default) it reports the local Docker Engine store: `baseUrl` is `""`, `pushRegistry` is
`docker-engine`, and ping, tags, and manifest answer from the Docker Engine (`docker image ls`,
`docker image inspect`). With `REGISTRY_BASE_URL` and `REGISTRY_PUSH_REGISTRY` set it talks to that
OCI registry instead.

Not yet part of the API: a repositories resource, artifact-bundle endpoints, outbound webhook
subscriptions, and API-token management. Do not build against them — they are not shipped. See
[What ships today](/docs/introduction/what-ships-today).

## Authentication

The API refuses to start unless `SEALANT_SERVICE_KEYS` holds at least one key. The one exception is
for development: with `SEALANT_ALLOW_OPEN_API=true` and `NODE_ENV` other than `production`, the API
serves `/v1` without a credential and takes identity from the payload (`ownerUserId`, which the SDK
defaults to `usr_local`). Published images run with `NODE_ENV=production` and ignore it. See
[Beyond localhost](/docs/guides/beyond-localhost) and the
[security model](/docs/concepts/security-model).

Every `/v1` request must carry a credential:

- A **service key** — one of the comma-separated secrets in `SEALANT_SERVICE_KEYS`, sent as
  `Authorization: Bearer <key>` (or `?token=<key>` on WebSocket routes). A service key belongs to a
  trusted product that owns its own login (Mend) and may assert any `ownerUserId`; the payload
  shapes are unchanged. Provision one Sealant user per person with `POST /v1/users` (idempotent on
  email) and send that id as the owner from then on.
- A **scoped user access token** (`POST /v1/access-tokens`; `slt_…`) authenticates the session
  surface (`/v1/sessions/*`, `/v1/workspaces/:id/forward`) on its own — a paired phone or desktop
  never holds a service key. A presented user token is authoritative: its owner and optional
  workspace narrowing become the principal, and its scopes are enforced.
- The internal SSH-gateway routes (`POST /v1/ssh-keys/resolve-principal`,
  `GET /v1/workspaces/:id/ssh-target`) keep their shared `x-sealant-gateway-token`
  ([`WORKSPACE_SSH_GATEWAY_TOKEN`](/docs/reference/environment-variables)); the SSH-target lookup
  also checks workspace ownership.

`/`, `/healthz`, `/readyz`, `/openapi.json` and `/docs` stay public in both modes. An
unauthenticated request in closed mode is answered `401 {"_tag":"UnauthorizedError"}`.

**Owner scoping on reads.** `GET /v1/workspaces/:id` and the `GET /v1/runs/:id` family (`/timeline`,
`/events/:sequence`, `/scrollback`, `/loss`, `/changes`) accept an optional `ownerUserId` query;
when present the resource must belong to that owner (uniform 404 otherwise). The SDK always sends
it. Keys never appear in logs or responses.

Related: [SDK](/docs/reference/sdk) · [Environment variables](/docs/reference/environment-variables)
· [Runs and execution records](/docs/guides/runs-and-execution-records)
