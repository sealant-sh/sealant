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

| Group                    | Operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System                   | `GET /`, `GET /healthz`, `GET /readyz`, `GET /v1/system/setup-state`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Packages                 | `GET /v1/packages/resolve?query=&targetOs=`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Workspaces               | `POST /v1/workspaces`, `GET /v1/workspaces/runtimes`, `POST /v1/workspaces/image`, `POST /v1/workspaces/:workspaceId/exec`, `POST /v1/workspaces/:workspaceId/dotfiles`, `POST /v1/workspaces/:workspaceId/stop`, `POST /v1/workspaces/:workspaceId/restart`, `POST`, `DELETE` and `GET /v1/workspaces/:workspaceId/credentials`, `POST /v1/workspaces/:workspaceId/expire`, `PATCH /v1/workspaces/:workspaceId/name`, `DELETE /v1/workspaces/:workspaceId/ssh-user`, `GET /v1/workspaces`, `GET /v1/workspaces/:workspaceId`, `GET /v1/workspaces/:workspaceId/attempts`, `GET /v1/workspaces/:workspaceId/events`, `GET /v1/workspaces/:workspaceId/ssh-target`                                                                                                                                                             |
| SSH keys                 | `POST /v1/ssh-keys`, `GET /v1/ssh-keys`, `DELETE /v1/ssh-keys/:sshKeyId`, `POST /v1/ssh-keys/resolve-principal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Users                    | `POST /v1/users` (idempotent on email), `POST /v1/users/:userId/person`, `GET /v1/users/:userId` — identity rows for service principals acting on behalf of their own users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Boat accounts            | `POST /v1/boat-accounts`, `GET /v1/boat-accounts`, `PUT /v1/boat-accounts/:boatAccountId/key`, `DELETE /v1/boat-accounts/:boatAccountId`, `POST /v1/boat-accounts/:boatAccountId/check`, `GET`/`POST /v1/boat-accounts/install-key` — the Boat keys an install keeps beside its default one, and their checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Resource domains         | `POST /v1/resource-domains` (idempotent on its `<application>:<name>` key), `GET /v1/resource-domains/:resourceDomainId`, `POST /v1/resource-domains/:resourceDomainId/members/:userId/grant` and `/revoke` (each at the application's own rising `version`; an older one gets `409`), `GET /v1/resource-domains/:resourceDomainId/members/:userId`, `GET /v1/resource-domains/:resourceDomainId/members` (paged by `limit` and `cursor`), `GET` and `PUT /v1/resource-domains/:resourceDomainId/budget` (CPU, memory and storage ceilings with what is used and reserved and a warning at 80% and 95%; a change names the `revision` it read, and a stale one gets `409`) — owners that are projects, not people. A service key only: any other bearer gets `401`, and a body field the contract does not declare gets `400` |
| Connected accounts       | `POST /v1/connected-accounts`, `GET /v1/connected-accounts`, `PUT /v1/connected-accounts/defaults/:provider`, `DELETE /v1/connected-accounts/:connectedAccountId`, `POST /v1/connected-accounts/:connectedAccountId/mark-invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Profiles                 | `GET /v1/profiles`, `GET /v1/profiles/:profileId/credential-bindings`, `PUT /v1/profiles/:profileId/credential-bindings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Runs / execution records | `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:runId`, `PATCH /v1/runs/:runId`, `GET /v1/runs/:runId/timeline`, `GET /v1/runs/:runId/events/:sequence`, `GET /v1/runs/:runId/scrollback`, `GET /v1/runs/:runId/loss`, `GET /v1/runs/:runId/changes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Registries               | `GET /v1/registries/:registryId`, `GET /v1/registries/:registryId/ping`, `GET /v1/registries/:registryId/extensions`, `GET /v1/registries/:registryId/tags?repository=`, `GET /v1/registries/:registryId/manifest?repository=&reference=`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GitHub                   | `GET /v1/github/installations`, `GET /v1/github/installations/:installationId/repositories`, `POST /v1/github/installations/import`, `POST /v1/github/installations/:installationId/sync`, `POST /v1/github/webhooks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The execution record is read through the run endpoints: `/timeline` is the ordered event stream,
`/scrollback` returns byte-exact process I/O, `/changes` is the file diff, and `/loss` reports any
gaps. See [Execution records](/docs/concepts/execution-records) for what these mean.

`/v1/workspaces/:workspaceId/credentials` holds people's logins in the homes of a running workspace,
one person per home.
`POST { ownerUserId, onBehalfOfUserId, home, uid?, gid?, claude?, codex?, github? }` writes copies
of that person's accounts (each an account id or name; `null` removes the provider) into `home`,
owned by the home's owner, mode `0600`, and keeps them refreshed there; GitHub is written as
`<home>/.config/gh/hosts.yml`. With `uid` and `gid` a home that does not exist yet is made for them.
`pi` and `opencode` name one of the person's Codex accounts and write its ChatGPT login (no refresh
token) as one entry of each tool's own `auth.json`: `openai-codex` in `<home>/.pi/agent/auth.json`,
`openai` in `<home>/.local/share/opencode/auth.json`. The file is merged in place, followed through
links to where it really is (which must be inside the home and outside `/workspace`), and its other
entries stay; a login the person made inside pi or opencode is never replaced, and `null` or a
release removes only Core's copy. A Codex account that is not a ChatGPT login answers `409`
`connected-account-unsupported`. A refresh of the Codex login rewrites these entries too. Without
`node` on the image's system PATH such a put, and a release or put that would remove a pi or
opencode login whose file exists, answer `409` `home-unusable` and change nothing (a release leaves
the home held), so no earlier holder's copy is left behind. With `partial: true` the put writes what
the person has connected and leaves out each provider whose account is refused (missing, invalid or
unsupported): its login is removed from the home, as `null` would remove it, and the answer's
`skipped: [{ provider, code, message }]` says which and why, instead of the whole put failing. A
login file that cannot be written in the home (not a regular file, another hard link, or, for pi's
and opencode's `auth.json`, really outside it) is left out the same way (`login-file-unusable`), and
the rest written. Every other refusal still fails it. A home holds one person's logins until it is
released: a `POST` naming anyone else answers `409` `home-held`. `DELETE ?ownerUserId=&home=`
releases the home (its login files are removed), and `GET ?ownerUserId=` lists the homes. A home is
an absolute path, never under `/workspace`, reached without a symbolic link (`409` `home-unusable`
otherwise); `/root` takes only the workspace owner's logins. A login file that is not a regular
file, or that has another hard link (a name elsewhere, which could be saved state), is refused `409`
`home-unusable`, naming it, and nothing is written into it. A login is never in any process's
arguments or environment: Core sends it on the exec's standard input, and the executor passes it on
the same way. Another write into the same home, or too many into the workspace at once, answers
`409` `home-busy`: nothing was done, try again. Only a service key may call them. A workspace with
no running executor answers `409` `workspace-not-running`. An account the person cannot name answers
`404` with `code` `connected-account-missing`, and one marked invalid or holding an unusable
credential `409` `connected-account-invalid`; both carry the account's `provider` (`claude`,
`codex`, `github`), so a caller can tell which login is missing without reading the message, and
nothing is written. A create's explicitly named account is refused the same way.

The account name `default` selects the person's chosen default for the provider, not an account of
that name, here, on a connect and in a profile binding: a person's first account for a provider is
named `default` and becomes their default, and `PUT /v1/connected-accounts/defaults/:provider`
chooses another. A person without one (their default was disconnected) gets
`connected-account-missing` until they choose again. A connect without `name` or `accountId`
replaces the person's only account for the provider; with several it answers `409`
`connected-account-ambiguous` with `candidateAccountIds`.

A create's `spec.runtime.credentialsHome` (`{ path, uid, gid }`) writes the launch's logins into
that home instead of `$HOME` and the environment (GitHub as `<home>/.config/gh/hosts.yml`), made for
that owner if missing, and records the home as the workspace owner's. A capture source's
`spec.sources.workspace.ownerMap` (`{ gid, worktreeUid, people: [{ id, uid }] }`) says who owns what
the daemon's restore writes: each person's saved directory (`<harnessHome>/people/<id>/`) theirs,
the worktree the group's, and, when it names anyone, an executor without no-new-privileges, so every
person's `sudo` works. It is checked at create (`400` with the reason): `gid` 40000, uids in
40001–49999, ids that are one directory name, no id or uid twice, at most 256 people; refused on
Cloudflare, and in `runtime.env`, whose names must be environment variable names. Kubernetes takes
it under runc and refuses it under gVisor (`ociRuntime: "runsc"`). The launch refuses it, with
nothing started, on an image whose sealantd does not report `restore.owner_map`
(`owner-map-unsupported`) and on one whose probe Core could not read (`owner-map-unverified`).
`GET /` reports `features.kubernetesPersonLayout: true` from a control plane that takes it on
Kubernetes. `POST /v1/workspaces/:id/capture/replan` takes `expectedOwnerMap` (`null` for none) and
answers `409` `owner-map-mismatch` on an executor launched with another map; the capture status
reports `ownerMap`. `POST /v1/workspaces/image { ownerUserId, registryId, spec }` answers, before
any create, the image plan the spec renders, the latest image published for it, and its per-person
capability (`personLayout`, also on every workspace read's `publishedImage`). An exec or a session
as a Linux user (a user name or uid) goes to its own route,
`POST /v1/workspaces/:workspaceId/exec-as-user` or `POST /v1/sessions/as-user`, with the same body
and `user` required, so a control plane that cannot run one answers `404`; `user` on `/exec` or
`/v1/sessions` is refused (`409` `user-unsupported`). The workspace's `sealantd` starts the process
as that user, and the run records it (`user`). Only a person in Mend's range (a uid in 40001–49999
whose primary group is `mend`, never root), on a workspace whose `sealantd` reports `exec.user`;
anything else answers `409` `user-unsupported`, saying why (the workspace's `sealantd` doesn't run
processes as another user, the user is not in range, or it does not exist yet), and starts nothing.
`sealantd` checks the passwd entry it resolves again and starts a process only as one of its owner
map's people or a person in Mend's reserved range (a uid in 40001–49999 whose primary group is
`mend`, so a person who joins after the executor booted runs too). Root, root's group and anyone
outside the range are refused, so a person who edits `/etc/passwd` with `sudo` cannot run a process
as root or a system user. Every workspace read reports `processUser` (`supported`, `unsupported` or
`unknown`, from its image's `sealantd`). `GET /` reports `features`: `processUserRoutes` (the
as-user routes; `processUser` stays `false`, the flag SDKs from before them read), `dotfilesApply`,
`credentialsPartialPut`, `credentialsPiOpencode`, `captureOwnerMap` and `workspaceSshUser`, so a
client detects them instead of reading the version.

A user's person (Mend's per-person layout: a person's Linux identity, the same in every workspace)
is bound once with `POST /v1/users/:userId/person { id, uid, home }`: the owner-map id, a uid in
40001–49999 (never root, never the `mend` group) and a home, an absolute normalised path under
`SEALANT_PERSON_HOMES_ROOT` (`400` otherwise). The home is checked by its spelling: the API sees no
executor's filesystem, so the prefix is no filesystem boundary (a link or a mount inside an executor
can lead elsewhere); what writes into a home in the executor refuses links and untrusted parents
itself. The same values again answer `created: false`. Another person for a bound user
(`person-binding-differs`), or a person id or uid that another user holds (`person-taken`), answers
`409` and changes nothing: each person id and uid belongs to at most one user. There is no rebind
route. An operator who must change a binding deletes that user's row in `user_person_binding` (a
change to the database, which your database audit records) and binds again. Every new binding is
logged at info with the user id, person id and uid.

## Runtimes

`GET /v1/workspaces/runtimes` answers, before any create, which runtimes this install launches
workspaces on and what each supports: `{ default, runtimes: [...] }`. `default` is the runtime a
create that names none (`target.runtime.family: "auto"`) runs on, and it is listed first. Boat is
listed only where a worker reports launching Boat workspaces and an account can run one, as the
create decides; its `resources` is unsupported when no launching worker has the resource gateway. A
runtime that is not listed is one this install cannot launch; a runtime the worker serves beside the
default, which the API cannot see, is not listed either.

Each entry is the runtime's row of the table the create is refused from:

| Field              | What it says                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `runtime`          | `docker`, `k8s`, `k3s`, `cloudflare`, `microvm` or `boat`                                           |
| `os`               | One item per managed OS family: `ubuntu`, `nix`, `arch`, `fedora`                                   |
| `customImage`      | A base image of the workspace's own (`target.os.family: "custom"`)                                  |
| `hostDirectories`  | Directories of the install's own servers bound in (a `mount` or `standby` source, `sources.mounts`) |
| `docker`           | Docker inside the workspace (`tooling.services.docker`)                                             |
| `gvisor`           | The workspace run under gVisor (`runtime.ociRuntime: "runsc"`)                                      |
| `clusterEnv`       | Kubernetes Secrets, ConfigMaps and a service account (`runtime.envFrom`, `runtime.kubernetes`)      |
| `gitSource`        | A workspace started by cloning a repository (a `git` source or a `sourceSelection`)                 |
| `dotfilesArchives` | Dotfiles sent with the create as archives (`runtime.dotfilesArchives`)                              |
| `screen`           | A screen (an X display) inside the workspace, with the CPU `architectures` it runs on               |
| `reservedPorts`    | Ports inside the workspace the runtime holds for itself (Boat's guest agent: 8080)                  |
| `resources`        | A project's resources linked to the workspace, with `attach`: `live` or `next-start`                |
| `idleCost`         | `{ charged, message }`: whether a workspace that sits idle costs money                              |

An item is `{ supported: true }` or `{ supported: false, message }`; `screen` and `resources` add
their detail when supported. `message` is the sentence to show a person who asks for the item. A
create (and a restart) that asks a runtime for an item it marks unsupported is refused with that
same sentence before anything is reserved: `422` with code `runtime-os-unsupported` for an OS
family, `workspace-docker-unsupported` for Docker, `runtime-env-references-unsupported` for
Kubernetes references outside Kubernetes (the message then names them), and
`runtime-requirement-unsupported` for the rest. Kubernetes reports port 7443 and gVisor as
supported: the worker's own `SEALANT_K8S_CONTROL_PORT` and gVisor runtime class are not visible to
the API, and the worker still refuses gVisor where the cluster has no runtime class for it.

## Boat accounts

An install's default Boat account is its env key (`SEALANT_BOAT_API_KEY` or
`SEALANT_BOAT_API_KEY_FILE`), and it is optional: an install can run Boat from the accounts it
stores alone. A product that serves several organizations stores one Boat account per organization,
so each organization's Boat VMs run in, and are billed to, its own Boat account. Core has no notion
of organizations: it knows each account by id, and the caller keeps the mapping. These routes need a
service key, and the install's credential key (`SEALANT_CREDENTIALS_KEY`; `503` otherwise). With no
env key, both `install-key` routes answer `503` and say so.

- `POST /v1/boat-accounts { label, apiKey, organization? }` checks the key with Boat by read-only
  calls before it stores anything (whitespace around a pasted key is trimmed). A key Boat refuses
  (unknown, revoked, expired, another organization's) answers `422` with code `boat-key-refused` and
  Boat's reason in `boat` (see the workspace's `error.boat` below); a key that provably lacks a
  permission Core needs answers `422` with code `boat-key-missing-permissions`, the permissions
  named in `missingPermissions` and the check in `report`; one Boat did not answer for
  `boat-key-unverified`. For a personal key, `organization` names the Boat organization to bill (its
  id or name): Core stores it and sends it as `X-Boat-Org` on every request for the account, so
  billing never follows the key's active wallet. The key is sealed with the install's credential key
  (`SEALANT_CREDENTIALS_KEY`) and is never returned by any route, logged or named in an error. The
  answer is `{ boatAccountId, label, state, createdAt, keyRotatedAt, organization, report }`.
- `GET /v1/boat-accounts` lists every stored account not removed. `state` is `active` or `removing`.
  Each carries its key's last `report`, null until it is checked.
- `POST /v1/boat-accounts/:boatAccountId/check` checks a stored account's key again and stores and
  answers the new report. A key Boat now refuses, or that lacks a permission, is reported, not
  refused; Boat not answering, or asking to wait (a rate limit), is `422` `boat-key-unverified`, and
  the last report stands.
- `GET /v1/boat-accounts/install-key` answers the install's own key (its env key, which workspaces
  run in when they name no account) as `{ label, report }`; never the key.
  `POST /v1/boat-accounts/install-key` checks it with Boat now, as a stored account's check does. It
  is not in the list.
- `PUT /v1/boat-accounts/:boatAccountId/key { apiKey }` replaces the key, checked as on create and
  billing the organization the account was stored with. The new key must see every VM of the
  account's live runs and every saved image its launches use, so a key of another Boat account is
  refused (`409`, code `boat-key-cannot-see`, with the count in `unseen`). Running workspaces stay
  in the account and use the new key from then on. Rotating or removing `default`, the install's own
  key, is refused (`409`, code `boat-account-environment`): it is set in the install's environment.

A key's `report` says what Core observed of it, from Boat's own answers, and when (`observedAt`).
Each fact is `{ observed: true, … }` or `{ observed: false, reason, boat? }`, where `reason` is
`refused` (Boat refused the read; `boat` says how), `no-answer`, `not-listed` (Boat's key list did
not include the key: an organization key is refused the list, a key limited to some VMs gets an
empty one) or `unreadable`. Core never guesses a fact it did not observe.

| Field                 | What it is, when observed                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`            | Who the key is (`GET /me`): `accountId` (Boat's account id, not a person here), `login`, `displayName`, `serviceAccount`, `accountStatus` |
| `keyKind`             | `personal` or `organization`                                                                                                              |
| `wallet`              | Which wallet a VM bills (`GET /limits`): `personal`, or `organization` with its id and name                                               |
| `requiredPermissions` | The permissions Core needs, one per Boat call it makes (always present)                                                                   |
| `permissions`         | The key's permissions (`GET /api-keys`), the required ones it lacks, whether it is limited to some VMs                                    |
| `expiry`              | `expiresAt` (null: never), `expired`, `expiringSoon`                                                                                      |
| `start`               | `canStart`, `blockedReason`, `billingStatus`, `runningVms`, `allowedVms`                                                                  |
| `snapshots`           | Saved snapshot slots `used` and `included`                                                                                                |

Core needs `exec`, `file.write`, `host`, `sandbox.create`, `sandbox.delete`, `sandbox.read`,
`sandbox.resume`, `sandbox.stop`, `snapshot.read` and `snapshot.write`. `sandbox.delete-own` is not
enough: after a rotation the new key deletes VMs the old key created.

- `POST /v1/boat-accounts/:boatAccountId/prove` runs a full check of a stored account's key, since
  Boat lets no key read all of its own permissions and has no dry run. Core starts the smallest VM
  in the account, runs a command in it, publishes a port and saves a snapshot, then deletes the
  snapshot and the VM. It answers
  `{ proofId, startedAt, finishedAt, outcome, steps, starts, leftBehind: { vm, snapshot } }`:
  `outcome` is `passed`, `refused` or `interrupted`; each of the six steps (`start-vm`,
  `run-command`, `publish-port`, `save-snapshot`, `delete-snapshot`, `delete-vm`) is `passed`,
  `refused` (with Boat's reason in `boat`), `no-answer` or `not-reached`. `starts` is how many VM
  starts it asked Boat for (0 or 1). `leftBehind` names what Boat may still hold of it when the
  answer is given; the worker's sweep removes it shortly after. Leaving nothing behind is how the
  check is built. It is recorded before anything is created, with what may be created. Whatever was
  issued is deleted when the check ends. A check that stops halfway is taken over by the worker's
  sweep, which deletes its VM (by id, or found by its label) and its snapshot (by name). The VM's
  own lifetime in Boat is 15 minutes. A second check of the same account while one runs, or while
  what it left is being removed, answers `409` `boat-proof-running`. `GET /v1/boat-accounts` carries
  each account's last check as `lastProof` (null until it is proven). It takes a minute or more.
- `DELETE /v1/boat-accounts/:boatAccountId` is refused while the account has runs whose VMs Boat may
  still hold, or an image build in flight (`409`, code `boat-account-in-use`, with `liveRuns` and
  `buildsInFlight`). Otherwise the account answers `state: "removing"`: no new workspace runs in it,
  and a worker that builds Boat images deletes the saved images Core built in the account, then
  erases its key. It leaves the list once that is done.

A Boat workspace whose launch or image build failed because Boat refused, or did not answer, a call
Core made reads `error.boat` beside `error.message` and `error.code` on `GET /v1/workspaces/:id`:
`{ kind, retryable, operation?, status?, code?, message?, requestId?, permission?, retryAfterSeconds?, retryAt?, billingUrl? }`.
`kind` is one of `key-refused`, `key-expired`, `permission-missing`, `sandbox-outside-key`,
`organization-mismatch`, `account-suspended`, `billing-required`, `running-limit`, `member-cap`,
`rate-limited`, `trial-restricted`, `no-machine`, `snapshot-allowance-full`, `no-answer` or
`refused` (see the SDK's `SealantBoatError`). `code`, `message` and `requestId` are Boat's own;
nothing else of Boat's answer is kept, and never the key. A launch Boat refused for a reason no
retry can change (the key, its permissions, the account, billing, plan limits) is not retried as a
create whose outcome is unknown.

An image build Boat refused for a reason a person fixes in Boat (`key-refused`, `key-expired`,
`permission-missing`, `sandbox-outside-key`, `organization-mismatch`, `account-suspended`,
`billing-required`, `member-cap`, `trial-restricted`, `snapshot-allowance-full`) stays quarantined,
and every launch on it reads the kind back, until its own cause may have cleared: the account's key
is rotated, or a check of it (`check`, `install-key`, or the worker's daily refresh) observes that
this cause is gone: Boat accepts the key again, every permission Core needs is held, the account is
active, the wallet can start a VM, or a saved snapshot slot is free. A check that clears another
cause leaves it quarantined. The next launch then builds it once more; a fresh refusal quarantines
the new build with the fresh reason until the next such event.

A workspace names its account at create in `spec.runtime.boatAccountId`, and every run of it,
restarts included, stays in that account. Omitted, it runs in the default account. An unknown or
removed account answers `404`, one being removed `409`, and naming one for a workspace that does not
run on Boat `400`.

Whether a Boat workspace can be launched is the worker's answer, not the API's guess: each worker
says every minute whether it launches Boat workspaces, whether it has the install's own key, and
whether it has the resource gateway, and the create reads the reports of the last five minutes (by
the database's clock). While the API itself started less than five minutes ago and no worker has
reported yet, the create is accepted and waits for the worker, as it did before. A Boat create (or
restart) that no worker could serve is refused before anything is reserved, `503`, with a sentence
that says who can change it: code `unsupported-runtime` when no worker launches Boat, or when the
install has neither its own key nor a stored account; `boat-account-required` when the spec names no
account and no launching worker has the install's own key; `gateway-unavailable` when the spec
reaches project resources (`runtime.resources` other than `"none"`) and no launching worker has the
resource gateway.

Each account has its own deployment label and builder owner, derived from its id, so two accounts
stored over the same real Boat account never read each other's VMs, and each builds its own saved
images, on its first launch. Every Boat run records the account it was created under, and every
later call for it (readiness, stop, recovery, sweeps, tunnels, control connections) uses that
account's key. Runs reach project resources through the install's resource gateway whatever their
account: the tunnel is carried over the VM's hosted HTTPS route, which the run's own account's key
opens.

A workspace's SSH sessions (an `ssh` shell or command, VS Code Remote-SSH) run as root unless its
create asks for its owner's own Linux user: `sshAsOwner: true` on `POST /v1/workspaces`. Core takes
the person the owner is bound to and checks the create against it: the create must carry a capture
owner map that gives that person their bound uid, and `runtime.credentialsHome` must be their bound
uid and home. Otherwise it answers `403` (`WorkspaceSshOwnerRefusedError`, code `ssh-owner-unbound`,
`ssh-owner-needs-owner-map` or `ssh-owner-mismatch`; no path is named). No caller names the user, so
no create can pick another person's identity.
`DELETE /v1/workspaces/:workspaceId/ssh-user?ownerUserId=` sets it back to root; nothing else
changes it. The user need not exist yet. The SSH gateway starts every shell and command of the
workspace's sessions as that user, with `HOME` and the rest from passwd, only on a `sealantd` that
reports `exec.user`, and the daemon admits only one of the executor's people; until the user exists
a session is refused, never run as root. The gateway asks who for every new session channel, so a
change reaches an SSH connection that is already open, and its disconnect-time working-tree capture
runs as the user too. SFTP runs as the user as well, on a `sealantd` that reports `sftp.user` (the
managed images carry an `sftp-server`), and is refused on one that does not: an upload is the
user's, takes a setgid directory's group, and inherits its default ACL.
`GET /v1/workspaces/:id/ssh-target` always states `sessionUser` (`null` for root), and a gateway
refuses an answer without it (an older API), never reading the silence as root; the API answers a
workspace with a user only to a gateway that says it runs sessions as one
(`x-sealant-gateway-ssh-user: 1`, else `409`). Upgrade the API and the gateway together. Only the
workspace's owner opens SSH sessions at all. When the gateway names the registered key a connection
logged in with (`x-sealant-ssh-key-fingerprint`), the API answers only while that key is still the
principal's (else `401` `WorkspaceSshKeyNoLongerRegisteredError`) and echoes it as
`sshKeyFingerprint`; the gateway refuses an answer without the echo (an older API) and ends the
connection on that refusal alone (another `401` refuses the channel), so removing a key ends the
connections opened with it.

A session's `argv` (`POST /v1/sessions` and `/v1/sessions/as-user`) starts with the program, which
must be non-empty with no leading or trailing whitespace. Every argument after it may be any string:
empty, whitespace-led or multi-line, as in `["bash", "-lc", "\n echo hi"]` or
`["git", "commit", "-m", ""]`. `sealantd` passes the arguments to the program as an argv array,
never through a shell, and Sealant stores only their count and lengths. Limits: at most 64 words,
131,071 bytes per word and 1 MiB in all, counted in UTF-8 bytes. 131,071 is the longest word
`execve` takes on Linux with 4 KiB pages: `MAX_ARG_STRLEN` is 128 KiB and counts the terminating
NUL. A word with a NUL byte is refused, since no process argument can carry one, and so is a lone
UTF-16 surrogate, which has no UTF-8 form.

A request any route cannot decode (a body that is not JSON or not an object, a field missing or of
the wrong type, a refused `argv`) answers `400` `RequestRefusedError` whose `message` names where
the request is wrong and what was expected (`argv[1] must be a string`,
`commands[0].args[1] must be a string`, `argv[1] contains a NUL byte`), never a value it held; a key
the caller chose, such as an `env` name, reads `[…]`. The server's request log, its error reporters
and the request's tracing span carry the refusal, not the request. A handler's own failure on a
request that decoded, a text payload's included, stays a `500`.

If the connection to `sealantd` drops before it answers an open, Sealant asks it again whether the
session's program started. A program it reports is the session's leader. If it reports none, the
session and its run are marked failed. If it cannot be asked, both stay open, and closing the
session finds the program and stops it. A close that cannot reach `sealantd` either changes nothing
and answers `502`, saying whether the program runs is unknown, so it can be retried.

Upgrade the control plane before the SDK. A control plane from before this rule refuses an empty or
untrimmed argument with an empty `400` and logs the argument; the SDK says so when it gets that
answer. An SDK from before this rule refuses such an argument itself, before it sends anything.

What the API observes (request spans, log lines, error reports) can hold credentials: the terminal
attach, the output stream and the port forward take their bearer as `?token=`, because browser
WebSocket and EventSource clients cannot set headers; request spans record URLs and headers; an HTTP
error quotes its request's URL and holds the request itself. Observers receive plain data only,
built when they observe it: text has every credential it can recognise replaced by `REDACTED`
(userinfo, plain, slash-escaped or percent-encoded; credential query parameters such as `token`,
`access_token`, `ticket`, `key` and `signature`; `Bearer` and `Basic` credentials in any case,
quoted or escaped; and the value of any field or header named for a credential, such as
`authorization`, `cookie` or `x-sealant-gateway-token`), an error arrives as its plain form (name,
tag, message, stack, fields), URLs, headers and requests as redacted plain data, and any other
object as its label. `?token=` is still accepted. Not redacted: a fiber's log annotations and
log-span labels, and a span's name and links; Sealant puts no credential there.

`POST /v1/workspaces/:workspaceId/dotfiles { ownerUserId, onBehalfOfUserId, user, home, repository?, archives? }`
(service key only) applies a person's dotfiles into their home of a running workspace, as their
Linux user (`sealantd` unpacks archives outside the home and writes every file in it as the user),
recording `onBehalfOfUserId` on the run: the sources of a create's dotfiles
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
