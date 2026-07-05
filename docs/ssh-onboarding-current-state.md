# SSH-into-sandbox: onboarding & key management — current state

**Status:** as-built reality, July 2026 (branch `feat/ssh-gateway-db-keys`). **Purpose:** hand-off
document. This describes _what exists today_ and _where it's messy_. It deliberately does **not**
propose a solution — that's the next task. Every claim is anchored to `file:line` so you can verify.

> **Addendum (packaging work, later on this branch):** the packaged-release changes resolved part of
> this doc — see `docs/packaging-one-line-install-plan.md`. Specifically: §7's "self-host cannot
> SSH" is fixed (`compose.selfhost.yaml` now ships web + ssh-gateway with bridge networking, control
> sockets, and a first-boot auto-generated host key via `SSH_GATEWAY_HOST_KEY_AUTOGENERATE`); the
> vestigial `SSH_UPSTREAM_*` vars are gone from `compose.yaml`; and the seed no longer hard-depends
> on the repo layout (`packages/db/src/seed-core.ts`). Identity convergence, fingerprint-uniqueness
> UX, and file-wins precedence (§8.1/8.2/8.4) remain open.

---

## 0. TL;DR — why this feels like a mess

SSH-into-sandbox works, but it grew across two half-finished migrations and it shows:

1. **Two identity systems that haven't converged.** Web users are minted dynamically by better-auth
   (random `id`). The SDK/self-host path uses one hardcoded static principal, `usr_local`, described
   in code as a stopgap "until auth lands." Nothing bridges them.
2. **A DB constraint makes physical keys single-owner.** An _active_ SSH key fingerprint is globally
   unique (`ssh_keys_fingerprint_active_idx`). So the seeded `dev_client_key` — registered to
   `usr_local` — literally cannot also be registered to a web user. Onboarding a web developer to
   SSH requires a _different_ key.
3. **The generated SSH client config hardcodes that one dev key** with `IdentitiesOnly yes`, and
   `pnpm ssh:setup:dev` rewrites it — so any hand-edit to point at a different key gets clobbered on
   the next setup run.
4. **Dual key-resolution (static file vs DB) with file-wins precedence** is a footgun: a DB
   revocation cannot override a key present in the static allowlist.
5. **The shipping self-host stack can't SSH at all.** `compose.selfhost.yaml` has no `ssh-gateway`
   service and its worker doesn't mount the control-socket dir. SSH is wired only in the dev
   `compose.yaml`.
6. **Onboarding is a brittle, order-sensitive, ~6-step manual sequence** with a built-image rebuild
   gotcha and a seed step that needs `DATABASE_URL` with no default.

Sections 1–7 document each of these precisely.

---

## 1. Identity model — two origins that don't meet

There are two completely separate ways a `user` row comes to exist, and the SSH ACL sits on top of
both.

### (A) Web flow — better-auth email/password

- `betterAuth({ emailAndPassword: { enabled: true }, ... })` with a Drizzle pg adapter —
  `packages/auth/src/server.ts:54-90`.
- Signup: `authClient.signUp.email({ email, name, password })` —
  `apps/web/src/routes/_auth/register.tsx:28`.
- Result: better-auth generates the `user.id` (its own random id, **not** `usr_local`), password
  hash in `account`, a `session`. These users register SSH keys under **Settings → SSH keys** or
  inline at sandbox creation.
- User table: `packages/db/src/schema/auth.ts:7-24` (better-auth
  `user`/`session`/`account`/`verification`).

### (B) SDK / CLI / self-host flow — one static principal `usr_local`

- `const DEFAULT_OWNER_USER_ID = "usr_local"` — `packages/sdk/src/internal/config.ts:26`, resolved
  as `env("SEALANT_OWNER_USER_ID") ?? DEFAULT_OWNER_USER_ID` (`:41`). The file header calls this a
  stopgap that "disappear[s] entirely once auth lands."
- The SDK stamps `ownerUserId: "usr_local"` onto every create/run payload. That `user` row must
  pre-exist — it's created by `db:seed`.

**These never converge today.** DEVELOPMENT.md:40 states it outright: "default owner (SDK/CLI; web
users sign up)." The whole `usr_local` mechanism is explicitly temporary auth scaffolding.

---

## 2. The key material — 3 keypairs + 2 allowlists

`pnpm ssh:setup:dev` (`tooling/scripts/setup-ssh-gateway-dev.mjs`) generates everything into
`.secrets/`. Each ed25519, no passphrase, distinct comment (`:176-187`).

| File                           | Role                                                             | Direction               | Consumed by                                                                                  |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `dev_client_key`(`.pub`)       | **client identity** — the human's key                            | human → gateway         | `IdentityFile` in generated ssh_config (`:242`); `.pub` also seeded into DB (§3)             |
| `gateway_upstream_key`(`.pub`) | gateway's key to authenticate **into sandboxes** (2nd hop)       | gateway → sandbox       | `SSH_UPSTREAM_PRIVATE_KEY_PATH` (compose.yaml:106)                                           |
| `ssh_gateway_host_key`(`.pub`) | gateway's **server host key** (what clients pin)                 | gateway server identity | `SSH_GATEWAY_HOST_KEY_PATH` (compose.yaml:102)                                               |
| `gateway_allowed_keys`         | static **break-glass allowlist**: who may enter the gateway      | —                       | `SSH_GATEWAY_ALLOWED_KEYS_FILE` (compose.yaml:103); contains `dev_client_key.pub`            |
| `authorized_keys`              | what sandboxes trust downstream (matches `gateway_upstream_key`) | —                       | `DEFAULT_SSH_AUTHORIZED_KEYS_FILE` (compose.yaml:68) — worker installs it into every sandbox |

Mental model: **`dev_client_key`** = you→gateway. **`gateway_upstream_key`** = gateway→sandbox.
**`ssh_gateway_host_key`** = gateway's own server identity. The two allowlists are the trust anchors
for the two hops.

---

## 3. Where keys get registered (4 paths)

1. **`db:seed`** (`packages/db/src/seed.ts`, `pnpm --filter @sealant/db db:seed`): creates user
   `usr_local` (email `local@example.test`, `:26-42`) and registers `.secrets/dev_client_key.pub`
   under it as `sealant-ssh-gateway-dev-client` (`:30-63`). Raw-`pg`, idempotent
   (`ON CONFLICT (owner_user_id, fingerprint) DO NOTHING`). **Requires `DATABASE_URL` (or
   `SEALANT_DATABASE_URL`), no default** — exits 1 otherwise (`:20-24`).
2. **Web UI — Settings → SSH keys** and **inline at sandbox creation**: `POST /v1/ssh-keys`, owner
   injected server-side by the web tRPC proxy (`ssh-keys.module.ts:26-30`).
3. **Static file** `.secrets/gateway_allowed_keys`: operator break-glass, not a DB row (§4).
4. (Read path only, not registration) the SDK never registers — it assumes the seeded `usr_local`
   key already resolves.

---

## 4. Runtime authorization path

The gateway (`apps/ssh-gateway/src/`) is an `ssh2.Server` toward the client; it does public-key auth
to identify a _principal_, then defers to the API for the actual ACL.

**Auth trace** (`gateway-server.ts` `handleAuthentication`, `:268-320`):

1. Only `publickey` accepted (`:270-273`).
2. `parseSandboxIdFromUsername(ctx.username, "sbx")` — username is `sbx-<id>`; the `<id>` is a
   _routing hint_ only (`:275-283`, `sandbox-target.ts:40-65`).
3. `resolveOfferedKeyPrincipal(...)` → principal, reject if none (`:287-295`).
4. Signature verification proves private-key possession (`:304-314`).

**Key → principal resolution order** (`resolveOfferedKeyPrincipal`, `:222-266`):

- **Static file FIRST** (`findAuthorizedKey`, local/synchronous, works when API is down). Principal
  = the key line's **trailing comment**, else `key:sha256(...)` (`authorized-keys.ts:22-62`).
- **DB API second**: `POST /v1/ssh-keys/resolve-principal`. Principal = the key's `ownerUserId`.
- **File wins.** Explicit comment `:220-221`: "A key in both resolves to the file's principal; DB
  revocation cannot override a file entry by design."

**`POST /v1/ssh-keys/resolve-principal`**
(`apps/api/src/routes/ssh-keys/ssh-keys.module.ts:225-263`):

- Auth: constant-time compare of `x-sealant-gateway-token` vs `SANDBOX_SSH_GATEWAY_TOKEN`
  (`:47-79`).
- Server recomputes the fingerprint from the offered blob (callers never supply one, `:234-242`);
  `findActiveSshKeyByFingerprint` (`:245-248`); 404 if unknown.
- Returns `{ principalId: sshKey.ownerUserId, sshKeyId, fingerprint }` — **the principal is
  literally the key's owner.**

**The ACL** lives in the API, not the gateway — `getSandboxSshTarget` in
`apps/api/src/routes/sandboxes/sandboxes.module.ts:1296-1301`:

```ts
// Owner-scoped authorization (ACL extension deferred): the principal must own this sandbox.
if (sandbox.ownerUserId !== principalId) {
  return yield* new SandboxUnauthorizedError({ ... });
}
```

**Net rule:** connection authorized iff (a) offered key resolves to a principal (file comment, or
active DB key's owner), (b) signature verifies, (c) `sandbox.ownerUserId === principalId`. Gated
further on runtime status `running`/`ready` (`:1303-1338`).

Transport: gateway runs `network_mode: host`, reaches the API at `http://127.0.0.1:4000`
(`CORE_API_BASE_URL`), and reaches sandboxes via **read-only** bind-mounted per-sandbox control
sockets (`/run/sealant/sockets:ro`, compose.yaml:93-96) — no Docker socket, so a gateway compromise
can't reach the host daemon (`control-transport.ts:10-21`).

---

## 5. The fingerprint-uniqueness crux

`ssh_keys` schema — `packages/db/src/schema/control-plane.ts:474-505`:

- `ssh_keys_owner_user_id_fingerprint_idx` UNIQUE `(owner_user_id, fingerprint)`.
- **`ssh_keys_fingerprint_active_idx` UNIQUE `(fingerprint) WHERE archived_at IS NULL`** — added in
  migration `20260705121122_purple_loners`. Rationale (inline `:498-500`): the gateway resolves a
  key to its owner _by fingerprint alone_, so an active fingerprint must be globally unique or
  key→principal is ambiguous.
- `archived_at` = soft delete; archived keys don't block re-registration (even by a different user).

**Consequence (this is the friction you hit):** one physical public key = at most one active owner,
globally. The seeded `dev_client_key` is owned by `usr_local`, so a web user **cannot** register
that same key — the service pre-checks and returns `SshKeyConflictError` "already registered to
another account" (`ssh-keys.module.ts:122-133`). Onboarding a web user to SSH therefore requires a
_fresh_ key.

The CRUD service does handle conflicts gracefully (idempotent per owner `:110-119`;
restore-if-archived `:140-155`; friendly errors both proactively and on the unique-index violation
`:157-184`). The friction isn't bugs — it's the model.

---

## 6. Dev setup script & the generated SSH client config

`pnpm ssh:setup:dev` → `tooling/scripts/setup-ssh-gateway-dev.mjs` (idempotent, managed-block
markers preserve user content).

**Writes to `~/.config/sealant/ssh_config`** (`:233-246`), Include'd from `~/.ssh/config`:

```
Host sbx-*
  HostName 127.0.0.1
  Port 2222
  User %n
  IdentityFile <repoRoot>/.secrets/dev_client_key
  IdentitiesOnly yes
  UserKnownHostsFile <home>/.config/sealant/known_hosts
  StrictHostKeyChecking accept-new
```

- `User %n` is deliberate — keeps the alias `sbx-<id>` as the SSH username so the gateway can parse
  the sandbox id (`:239-241`).
- `IdentityFile` is hardcoded to `dev_client_key`; `IdentitiesOnly yes` means _only_ that key is
  offered.
- **Any edit to point at a different key is overwritten** the next time `ssh:setup:dev` runs
  (managed block).

**Appends to repo-root `.env`** (`:199-210`) a managed block: `SANDBOX_SSH_GATEWAY_TOKEN` (random
24-byte hex, preserved once set), `SANDBOX_SSH_GATEWAY_HOST=127.0.0.1`,
`SANDBOX_SSH_GATEWAY_PORT=2222`, `SANDBOX_SSH_GATEWAY_USERNAME_PREFIX=sbx`. `.env.example:19-22`
documents that the script owns these and they must NOT be set by hand (api, worker, gateway must all
agree on the token).

---

## 7. Topology & the self-host gap

### Dev — `compose.yaml`

- **Always-on** (`docker compose up -d`): `postgres` (127.0.0.1:5433), `rabbitmq` (5673), `zot`
  (5000).
- **Behind `--profile apps`** (`docker compose --profile apps up -d --build`): `worker` and
  `ssh-gateway`, both **built images** (`build:` from their Dockerfiles).
- `ssh-gateway`: `network_mode: host`, listens 127.0.0.1:2222, `env_file: ./.env`, mounts `.secrets`
  ro + `/run/sealant/sockets:ro` (compose.yaml:78-108).
- **api & web run on the host** (`pnpm --filter ... dev`), hot-reload — not in compose.

### Built-image gotcha

Worker + gateway copy code into the image. After a code change (or merging `main`) you must
`docker compose --profile apps up -d --build <svc>`; a `restart` runs stale code
(DEVELOPMENT.md:74-75). The static `gateway_allowed_keys` is loaded **once at gateway start**
(`index.ts:11-18`) — changing it needs a restart too.

### Self-host — `compose.selfhost.yaml` (the shipping path)

- All-in-one, always-on: `postgres`, `rabbitmq`, `zot`, a one-shot `migrate` (runs
  `db:migrate && db:seed`, `:59-74`), `api`, `worker`.
- **No `ssh-gateway` service. The worker does not mount `/run/sealant/sockets`.** → As shipped,
  self-host **cannot SSH into a sandbox**. SSH is a dev-compose-only capability right now.

---

## 8. Friction / open questions for the design task

Framed as observations, not answers:

1. **Identity convergence.** `usr_local` is explicitly temporary. What is the real auth model, and
   does the SDK/self-host principal become a real account or an API-key identity? Everything else
   keys off this.
2. **Physical key ↔ owner cardinality.** The global-unique-active-fingerprint rule means a dev can't
   reuse one key across `usr_local` and their web account, and two users can't share a key. Is that
   the desired product constraint, or an artifact of resolving principals by fingerprint alone?
3. **Generated ssh_config is single-key and self-overwriting.** Onboarding a web user today means
   either a fresh key + manual `IdentityFile` edit (clobbered on re-setup), or re-homing the dev
   key. Neither is a shippable UX.
4. **Dual resolution (file-wins).** Static allowlist overrides DB, and DB revocation can't touch a
   file entry. Fine as break-glass; risky as a general mechanism. Should the file path exist in
   production at all?
5. **Self-host has no SSH.** Closing this is likely core to "ship to users" — needs a gateway
   service, socket wiring, host-key/token provisioning, and a key-onboarding flow that isn't the dev
   script.
6. **Provisioning secrets at scale.** Today one `.env` token is shared across api/worker/gateway via
   a dev script. Self-host/multi-tenant needs a real secret-distribution story (the token, the three
   keypairs, host-key trust/pinning for clients).
7. **Setup is a 6-step ordered ritual** (`ssh:setup:dev` → `up -d` → `db:migrate` → `db:seed` → run
   api/web → `up --profile apps --build`) with a no-default `DATABASE_URL` on seed. What's the
   target one-command onboarding for (a) a new contributor, (b) a self-host operator, (c) an end
   user adding their key?
8. **`profile_ssh_key_bindings` exists but is under-surfaced.** Schema supports binding keys to
   profile revisions with a `purpose` enum (`login`/`git-auth`/`git-signing`,
   `control-plane.ts:532-552`) — a richer per-profile key-injection model that the current
   onboarding doesn't expose. Worth knowing it's there.

---

## 9. File map (jump-off points)

| Concern                      | Path                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| Dev setup script             | `tooling/scripts/setup-ssh-gateway-dev.mjs`                      |
| Seed (usr_local + dev key)   | `packages/db/src/seed.ts`                                        |
| ssh_keys / bindings schema   | `packages/db/src/schema/control-plane.ts:474-552`                |
| better-auth user schema      | `packages/db/src/schema/auth.ts`                                 |
| Gateway auth loop            | `apps/ssh-gateway/src/gateway-server.ts:222-333`                 |
| Static allowlist parsing     | `apps/ssh-gateway/src/authorized-keys.ts`                        |
| Gateway→API principal lookup | `apps/ssh-gateway/src/principal-resolver.ts`                     |
| Gateway→sandbox transport    | `apps/ssh-gateway/src/control-transport.ts`, `sandbox-target.ts` |
| resolve-principal endpoint   | `apps/api/src/routes/ssh-keys/ssh-keys.module.ts:225-263`        |
| SSH-keys CRUD service        | `apps/api/src/routes/ssh-keys/ssh-keys.module.ts:95-224`         |
| The ACL                      | `apps/api/src/routes/sandboxes/sandboxes.module.ts:1256-1340`    |
| API contract                 | `packages/api-contracts/src/core-api/ssh-keys.ts`                |
| SDK default owner            | `packages/sdk/src/internal/config.ts:26`                         |
| Dev compose                  | `compose.yaml`                                                   |
| Self-host compose            | `compose.selfhost.yaml`                                          |
| Human runbook                | `DEVELOPMENT.md`                                                 |
