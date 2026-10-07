# Connected Accounts: bring-your-own AI subscriptions (+ GitHub token), profiles, and the `sealant` CLI

_Design doc, July 2026. Covers: how users connect their Claude / ChatGPT-Codex subscriptions and
GitHub identity to a self-hosted Sealant, how those credentials are stored, bundled via profiles,
injected into sandboxes, exposed to the SDK, and used internally — plus the first cut of the
`sealant` CLI, which is the primary acquisition surface._

## 1. Goals

- Auth once: a user connects their Claude subscription, ChatGPT/Codex subscription, and GitHub
  identity a single time; Sealant stores the credentials encrypted in the control plane.
- Bundle: credentials attach to **profiles** so a sandbox/run picks up a whole working identity in
  one reference.
- Flow everywhere: sandboxes get them at launch (harness auth just works), the SDK can request them
  for sandboxes it creates, and Sealant itself can use the Claude credential for internal agentic
  features (e.g. summarizing a run) — through the official Agent SDK only.
- Both surfaces: connect/manage from the web settings UI **and** from the new `sealant` CLI.
- Zero ToS violations. Every acquisition and use path below is anchored to the providers' published
  rules as of July 2026 (research summary in §2).

Non-goals (v1): org/team sharing of credentials (auth schema has no org model yet), credential use
for raw model API calls, our own GitHub OAuth/GitHub-App user-token flow (documented as the roadmap
replacement for the gh-CLI token), K8s runtime support (Docker adapter is the only real runtime
today).

## 2. Compliance ground rules (what the research established)

Self-hosting helps us everywhere: Sealant runs in the **user's own infrastructure**, so traffic
originates from machines the subscriber controls, and Sealant-the-vendor never routes, pools, or
resells anything. We still design as if we were a hosted third party, because that's the durable
posture.

### Claude (Anthropic) — strictest provider

- **Compliant acquisition (two shapes, both operator-initiated):** (a) the user runs
  `claude setup-token` themselves and pastes the resulting `sk-ant-oat01-…` token — the officially
  documented headless/CI path (1-year, inference-scoped, **no refresh token — by design**; Anthropic
  classifies setup tokens as API auth, so interactive use of some models is credit-gated on them).
  (b) the user deliberately mints a **session credentials file for Sealant** — e.g.
  `CLAUDE_CONFIG_DIR=~/.config/sealant/claude-session claude` + `/login`, then pastes the contents
  of that directory's `.credentials.json` — a full Claude Code session that presents as their
  subscription. In both paths the CLI may _spawn_ the official `claude` binary interactively for
  convenience; the OAuth loop is entirely Anthropic's.
- **Hard don'ts (encoded in code, not just docs):** Sealant never READS credential files
  (`~/.claude/.credentials.json`) or the OS keychain off the operator's machine — a session file
  enters Sealant only when the operator deliberately pastes one they minted for it; consent is the
  paste. Never initiate OAuth or embed Claude Code's client id; never call Anthropic's token or
  inference endpoints with the subscription token; never proxy Claude traffic through Sealant
  services. Anthropic blocked and sent legal requests to tools that spoofed the Claude Code client
  (Jan–Apr 2026).
- **Permitted consumption:** setup tokens inject as `CLAUDE_CODE_OAUTH_TOKEN` _(into a home: as a
  credentials file, §6b)_; session files are materialized at `$HOME/.claude/.credentials.json` (mode
  600, exactly like codex's auth.json) — both only where the **official Claude Code CLI / Agent
  SDK** runs. Help Center 15036540 explicitly covers "third-party apps that authenticate with your
  Claude subscription through the Agent SDK". Don't run `claude --bare` (ignores the env var).
  Internal features (run summaries) must go through the Agent SDK, never raw `POST /v1/messages`.
- **Refresh story** _(superseded for session files by §6a, Oct 2026: the worker is the only
  refresher and every other copy has no refresh token)_: setup tokens: none — detect 401s → mark the
  account `invalid` → prompt re-auth; record `connectedAt` and nudge near the 12-month mark. Session
  files: the official CLI refreshes the session in-container; Sealant syncs the mutated file back
  after runs **and on every container teardown path** (workspace stop, expiry reap — interactive/PTY
  sessions rotate tokens without ever running an exec job), newest-wins on `claudeAiOauth.expiresAt`
  (mirrors the codex sync-back). _Extended (Aug 2026):_ the control plane also lets the CLI refresh
  outside workspaces, always through a private per-invocation `CLAUDE_CONFIG_DIR` (0700 dir / 0600
  file) holding the decrypted session file: (a) **inference at point of use** runs the Agent SDK
  against that config dir instead of passing the access token via env, so an expired token is
  refreshed by the CLI right where it is consumed; (b) a **keep-fresh worker sweeper** scans active
  session-file accounts every ~15 minutes and, for any expiring within ~30 minutes, runs a minimal
  one-turn official-CLI exchange against such a config dir (deliberately spending a trivial slice of
  the subscription — operator-approved). Both read the rotated file back and persist it through the
  same newest-wins + 30-day-plausibility guards. The hard rule is unchanged: Sealant NEVER calls
  Anthropic's token endpoint — every refresh is performed by the official CLI/Agent SDK.
- Always offer `ANTHROPIC_API_KEY` as a first-class alternative; it is Anthropic's stated preference
  for products and our fallback if policy shifts again (four swings Jan–Jun 2026).

### Codex (OpenAI) — most permissive, but refresh rotates

- **Compliant acquisition:** the user runs `codex login` on their machine; with explicit consent the
  CLI reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) and uploads it. Copying auth.json to
  another machine to run Codex there is **OpenAI's own documented CI/CD pattern** ("put that file on
  the runner, run Codex normally, let Codex refresh the session, keep the refreshed auth.json").
  Device-auth (`codex login --device-auth`) inside a sandbox is the headless fallback.
- **Hard don'ts:** never call `auth.openai.com` ourselves (Codex's client id is not ours to use);
  never extract `access_token` for raw Responses-API calls; never pool credentials.
- **Refresh story** _(superseded by §6a, Oct 2026: the worker is the only refresher, through
  `codex app-server`, and every other copy carries a placeholder refresh token)_: the official Codex
  CLI in the sandbox refreshes (proactively at ~8 days staleness, reactively on 401) and **rotates
  the refresh token**. We must sync the mutated auth.json back after runs, only ever overwrite our
  stored copy with a _newer_ `last_refresh`, and keep one live copy per credential (concurrent
  refreshes can permanently brick it). Seed the sandbox only at launch; never re-seed a stale copy
  over a fresh one. _Extended (Aug 2026):_ the control plane also lets the CLI run outside
  workspaces — **inference at point of use** spawns the official `codex exec` against a private
  per-invocation `CODEX_HOME` (0700 dir / 0600 auth.json) holding the decrypted file, reads the
  possibly-rotated auth.json back when the exchange ends, and persists it through the same
  newest-wins guard the workspace sync-back uses (`persistCodexAuthJsonIfNewer`). The hard rule is
  unchanged: Sealant NEVER calls OpenAI's token endpoint — every refresh is performed by the
  official CLI.

### GitHub — gh CLI token now, own GitHub App user-tokens later

- `gh auth token` is a documented public command; gh maintainers acknowledge scripts/extensions
  consuming it. Feeding its output to another tool is fine; the ToS only bans token sharing to evade
  rate limits. Tokens are classic `gho_` OAuth tokens: **no time expiry**, revoked only by 1yr
  non-use, public leak, user revoking the "GitHub CLI" app, or the **10-tokens-per-app/scope rule**
  (logging into gh on many machines silently kills the oldest token — our only signal is a 401).
- We ask the user to run `gh auth token` (or shell out to it after explicit confirmation) — we do
  **not** silently read `hosts.yml`/keyrings, and we never mint tokens with gh's client id.
- Verify scopes at connect time via the `X-OAuth-Scopes` response header: require `repo`, warn if
  `workflow` is missing (agents editing `.github/workflows/*` will fail pushes without it).
- Roadmap note (documented, not built now): a Sealant GitHub App with device/web flow issuing 8h
  user tokens + 6mo rotating refresh tokens is the strictly better long-term backbone (short-lived
  sandbox tokens, per-app revocation, org-friendly). The schema below leaves room for it
  (`kind: "gh-cli-token"` today, `"github-app-user"` later).

## 3. Data model

New provider-credential tables in `packages/db/src/schema/control-plane.ts`, following existing
conventions (text ids with prefixes minted at the API call site, `snake_case` tables, owner FK to
`user`, `archivedAt` soft delete).

```
connectedAccountProviderValues = ["claude", "codex", "github"]
connectedAccountStatusValues   = ["active", "invalid", "archived"]

connected_accounts
  id                text pk            -- "cacc_<uuid>"
  owner_user_id     text -> user.id (cascade)
  provider          enum^
  name              text not null default 'default'   -- multiple accounts per provider allowed
  kind              text not null      -- "oauth-token" | "credentials-json" (claude) | "auth-json" (codex) | "gh-cli-token"
  status            enum^ default 'active'
  encrypted_payload text not null      -- AES-256-GCM sealed JSON (see §4)
  encryption_key_id text not null
  payload_sha256    text not null      -- change detection without decryption
  metadata          jsonb not null     -- NON-secret display/ops data (see below)
  connected_at / updated_at / last_used_at / last_synced_at / invalid_at / archived_at

  unique (owner_user_id, provider, name) where archived_at is null
  index (owner_user_id, provider, status)

profile_connected_accounts        -- the "bundle" piece
  profile_id           text -> profiles.id (cascade)
  provider             enum^
  connected_account_id text -> connected_accounts.id
  pk (profile_id, provider)      -- one account per provider per profile
```

**Why profile-level, not revision-level bindings** (unlike `profile_secret_bindings`): revisions are
content-addressed environment _configuration_; a connected account is a live _identity pointer_.
Rotating a token or re-linking an account must not fork a revision or change a fingerprint — same
reasoning as `profiles.activeRevisionId` living on the profile row.

**Payload shapes** (the JSON that gets encrypted), defined as Effect Schemas in
`@sealant/credentials`:

- `claude`: `{ token: "sk-ant-oat01-…" }` (setup token) or
  `{ credentialsJson: "<verbatim file contents>" }` (session credentials file) — consumers dispatch
  on the payload shape, not the `kind` column.
- `codex`: `{ authJson: "<verbatim file contents>" }` — stored verbatim so we can re-materialize the
  exact file; parsed on write to validate shape and extract metadata.
- `github`: `{ token: "gho_…" }`

**Metadata examples** (never secret): claude `{ tokenSuffix, connectedVia }` or (session file)
`{ tokenSuffix, subscriptionType, expiresAt, scopeCount, connectedVia }`; codex
`{ accountId, authMode, lastRefresh, email? }` (from the id_token claims, extracted server-side);
github `{ login, scopes[], tokenType: "gh-cli" }`.

## 4. Encryption at rest — `@sealant/credentials`

There is no encryption service in the repo today (the `secrets` tables are schema-only; the only AES
code is Linear cookie-sealing in apps/web). New shared package **`packages/credentials`**
(`@sealant/credentials`), consumed by `apps/api` (encrypt on write) and `apps/worker` (decrypt at
launch):

- `CredentialCipher` Effect service (contract first, live layer separate, per house rules):
  AES-256-GCM via `node:crypto`, key from env `SEALANT_CREDENTIALS_KEY` (32-byte base64; added to
  `packages/validators/src/env.ts` for api + worker with a superRefine that it decodes to 32 bytes).
  Sealed format `v1.<keyId>.<iv>.<authTag>.<ciphertext>` base64url — `encryption_key_id` column +
  format prefix leave room for rotation.
- Provider payload schemas + parse/validate helpers (`parseCodexAuthJson`, claude token format
  check, gh token shape check + scope parsing).
- **Injection planner**: pure function from decrypted credentials → an injection plan the runtime
  adapter executes:
  - claude (setup token) → env `CLAUDE_CODE_OAUTH_TOKEN` (into a home: the file of §6b); claude
    (session file) → file `$HOME/.claude/.credentials.json` (mode 0600)
  - codex → file `$HOME/.codex/auth.json` (mode 0600)
  - github → env `GITHUB_TOKEN` + `GH_TOKEN`, optional git clone auth (§6)
- Self-host bootstrap: `install.sh` / compose generate `SEALANT_CREDENTIALS_KEY` once (follow-up in
  the packaging repo path; documented in the env schema description now).

Credential material **never** transits job-queue payloads and never appears in blueprints —
blueprints carry opaque refs (`connected-account:<id>`), the worker resolves and decrypts just
before launch. This mirrors the existing `github-installation-repository:<id>` authRef pattern.

## 5. Control-plane API

New contract `packages/api-contracts/src/core-api/connected-accounts.ts` +
`apps/api/src/routes/connected-accounts/*`, mounted at `/v1/connected-accounts` — same trust model
as ssh-keys (caller supplies `ownerUserId`; the web tRPC proxy and the CLI are the intended callers
inside the deployment's trust boundary):

- `POST /v1/connected-accounts` — connect/replace. Payload: `ownerUserId`, `provider`, `name?`,
  `secret` (provider-shaped plaintext over the internal API; encrypted server-side). Validates
  provider shape (claude token prefix, codex auth.json parse, github token live scope-check against
  `api.github.com` when reachable), extracts metadata, upserts on (owner, provider, name),
  resurrects archived rows.
- `GET /v1/connected-accounts?ownerUserId=…` — summaries only (id, provider, name, status, kind,
  metadata, timestamps). **No endpoint ever returns secret material.**
- `DELETE /v1/connected-accounts/:id` — archive (also clears profile links).
- `POST /v1/connected-accounts/:id/mark-invalid` — internal, for 401 feedback from the worker.
- Profiles: minimal `/v1/profiles` group (list by owner; set/clear per-provider account binding) so
  web + CLI can manage bundles. (Profiles repos already exist; this is their first API surface.)

`/v1/workspaces/:id/credentials` puts a person's logins into one home of a running workspace; see
§6c for what it records and who may call it.

Sandbox creation (`sandboxes.module.ts`): `NewSandbox` gains optional
`credentials?: { profileId?: string; claude?: string; codex?: string; github?: string }` (account
ids, or names resolved per provider). Explicit ids win over the profile's bindings. The module
verifies ownership + `active` status, then embeds `credentialRefs` (provider +
`connected-account:<id>`) into the blueprint. Runs inherit the sandbox's refs.

## 6. Sandbox injection (worker + runtime adapter)

In `packages/sandboxes`:

- `credential-resolver.ts` (worker, sibling of `github-installation-auth-resolver.ts`): resolve each
  ref via a new `ConnectedAccountRepo`, decrypt with `CredentialCipher`, build the injection plan.
  Marks accounts `last_used_at`.
- `DockerRuntimeAdapter.launch` additions:
  - env entries join the existing `-e` args (same exposure profile as today's clone tokens — the
    plaintext-argv weakness is pre-existing and tracked as a separate hardening item);
  - **file injections** are new: after the container is ready, write via
    `docker exec -i <c> sh -c 'umask 077 && mkdir -p "$(dirname <path>)" && base64 -d > <path>'`
    with content piped over stdin — file bytes never appear in argv, image layers, or
    `docker inspect`. `$HOME` expansion happens inside the container shell.
- **Codex sync-back:** when a run-exec job completes (and on sandbox stop where reachable), the
  worker `docker exec cat`s `$HOME/.codex/auth.json`, parses `last_refresh`, and updates the stored
  credential iff strictly newer (`last_synced_at` bookkeeping). Never write an older copy.
- **Claude session sync-back:** same shape for `credentials-json` claude accounts —
  `$HOME/.claude/.credentials.json` is read back after runs and persisted iff its
  `claudeAiOauth.expiresAt` is strictly newer. Lineage guards: the runtime instance row records the
  launch-time injection shape per account, and only workspaces where Sealant FILE-injected the
  account may sync it back (env-injected workspaces never do — harnesses may fabricate the file
  there); an observed `expiresAt` more than 30 days ahead is rejected as a sentinel; and the stored
  payload must itself be a session file, so setup-token accounts are never silently converted.
- **Known v1 limitation (sync-back vs reconnect race, codex parity):** if the operator reconnects a
  credential with a NEW same-shape session while a workspace launched with the old one is still
  alive, that workspace's end-of-run sync-back can win newest-wins (its rotation may carry the
  freshest marker) and resurrect the old session's lineage over the deliberate replacement. Both
  providers accept this in v1; the mitigation is stopping live workspaces that use the account
  before reconnecting it.
- **GitHub as clone auth:** when a sandbox's source has no GitHub App installation authRef but the
  launch has a github credential, the worker may use it as `http-token` clone auth
  (`x-access-token:<token>`) — this is what lets self-hosters skip the GitHub App entirely.
- 401/invalid detection from harness traffic is a follow-up (needs run-record signal plumbing); v1
  marks invalid only on sync-back/API-observed failures.

## 6a. One refresher (Oct 2026)

**Why.** On Mend's alpha (2026-09-30) one person's Claude and Codex logins were both dead at once.
Codex had been pasted from a laptop whose own Codex refreshed first
(`refresh token was already used`). Claude was a login of its own, and still died: the store had
handed one login to every workspace and every inference call, each copy's CLI could refresh it, and
a rotation that did not make it back to the store (the machine was drained, the read-back failed)
left the store holding a revoked access token and a spent refresh token. The sync-back guards
(newest-wins, one live copy) could not prevent that; only one refresher can.

**What the harnesses do** (tested 2026-10-01, Claude Code 2.1.286 and Codex 0.159.2/0.148.0, with
throwaway logins wherever something refreshed):

|                                             | Claude Code                                              | Codex                                                                                   |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Runs with no refresh token                  | yes, field removed                                       | yes, with a placeholder (the field is required)                                         |
| Reads the credential file                   | before every request                                     | once; again after a 401 or within 5 min of expiry                                       |
| Takes a replaced file mid-session           | yes, next request                                        | yes, after a 401 (reload, then retry)                                                   |
| A refresh revokes the previous access token | yes, at once                                             | no                                                                                      |
| Refresh with a spent refresh token          | refused; that copy's file is cleared; the login survives | accepted within a grace period                                                          |
| Refresh on demand, through the CLI          | an expired `expiresAt` makes the CLI refresh on use      | `app-server` `getAuthStatus`/`account/read` with `refreshToken: true`, no model request |

**Decision.**

- **Copies cannot rotate.** `@sealant/credentials` `claudeCredentialsCopy` (no `refreshToken`) and
  `codexAuthJsonCopy` (`CODEX_COPY_REFRESH_TOKEN`) produce every file a workspace or an inference
  call gets. The persist cores refuse a copy (`skipped-copy`), so none can replace the stored login.
- **The worker is the only refresher.** `refresh-claude-sessions.ts` (every 15 min, an hour before
  expiry, the private copy's `expiresAt` marked as passed so the CLI refreshes on its ping) and
  `refresh-codex-sessions.ts` (hourly, a day before the access token's `exp`, through
  `codex app-server`). One refresh per login at a time across workers:
  `connected_accounts. refresh_claimed_until`. The stored file is persisted before anything else is
  done with it.
- **Push.** `pushCredentialCopy` writes the new copy into every running runtime instance whose
  launch file-injected the account, and into every home that holds it (§6c), in parallel, over the
  control connection (the launch's exec-with-stdin write), never the run-exec queue. Claude's
  previous token is revoked by the refresh, so the push runs straight after it; a request caught
  between gets a 401, re-reads the file and retries. Codex's previous token stays valid.
- **Refused means ended.** A refused refresh marks the account `invalid` (`markInvalid`): the
  resolver refuses launches with it, and inference answers `reconnect Claude` / `reconnect Codex`.
- **Read-back only for older launches.** The runtime instance row marks copies (`copy: true` in
  `launch_credential_injections`); sync-back skips them and still reads workspaces launched before
  copies, whose files can rotate, until they end.

**Unchanged.** Sealant never calls a provider's OAuth or token endpoint: every sign-in is the
provider's own flow, every refresh is the provider's own CLI. A login belongs to its owner and is
selected only for that owner's work (§5).

## 6b. A setup token as a credentials file (Oct 2026)

`claudeCredentialsFile(payload)` turns a Claude login into the credentials file, whichever shape it
is stored in. A session file becomes the copy a launch writes (§6a). A setup token becomes what
Claude Code builds for itself from `CLAUDE_CODE_OAUTH_TOKEN`: the token as `accessToken`,
`scopes: ["user:inference"]`, `subscriptionType: null`, no refresh token, and `expiresAt` in year
2286 (a missing or past expiry would read as expired). It is a copy: nothing reads it back or
refreshes it.

- **Where it is used.** Where logins go into a home (one person's, in an executor several people
  share), a variable would be one value for the whole container and fixed for the life of every
  process that read it, so the file is what is written there. A launch at `$HOME` (one container,
  one person) keeps the planner's `CLAUDE_CODE_OAUTH_TOKEN`: writing a file there would add an exec
  to every such cold launch, for nothing. Inference outside workspaces (the Agent SDK in the API
  process) keeps the variable too.
- **Verified** against Claude Code 2.1.289 (the version Core's images carry), in a container, with
  `ANTHROPIC_BASE_URL` pointed at a recording server. With only this file in `~/.claude`,
  `claude auth status` reports `loggedIn: true, authMethod: claude.ai`. `claude -p` and the TUI both
  send `Authorization: Bearer <token>` with the `oauth-2025-04-20` beta, and the TUI opens straight
  to its prompt. Without the file, both say "Not logged in".
- A setup token lives a year and cannot be revoked by a refresh, so unlike a session copy it stays
  usable after it leaves a workspace: whoever could read the file while it was written there keeps a
  working token until it is revoked from the Claude account.

## 6c. A person's logins in each home (Oct 2026)

**Why.** In Mend's per-person layout (Mend ADR 0016) several people work in one executor, each as
their own Linux user, and every process runs as one person, on that person's own logins. A
workspace's logins can no longer be one set for the whole container: a person's logins go into that
person's home (or a conversation home while that person's process is about to run there), and
nowhere else. A login is never switched in place in a running process: a new sender gets a new
process, and its home gets the sender's logins.

**Endpoints.** `/v1/workspaces/:id/credentials` (SDK `workspace.credentials`):

```
POST   { ownerUserId, onBehalfOfUserId, home, claude?, codex?, github? }   → { workspaceId, runId, home: Home }
DELETE ?ownerUserId&home                                                   → { workspaceId, runId, home, released }
GET    ?ownerUserId                                                        → { workspaceId, runId, homes: Home[] }
   Home = { home, onBehalfOfUserId, accounts: { claude?, codex?, github?: { connectedAccountId, name } } }
```

- **Resolve as create does.** Each value is an account id (`cacc_…`) or a name under the provider,
  of `onBehalfOfUserId` (`true` in the SDK is `default`). Unknown, someone else's, wrong-provider
  and archived accounts are one uniform 404; an `invalid` one is a 409 `connected-account-invalid`.
  Create and the put share the resolver. `null` removes that provider's login from the home (the
  person has not connected it); a provider left out is left as it is.
- **Write a copy, owned by the home's owner.** Each account is resolved and decrypted under the
  home's lock (below), so a refresh that persisted while the put waited is what is written, never
  the token it revoked. Claude is written as the file of §6b (a session file's copy, or a setup
  token's file: a variable would be everyone's in a shared executor), Codex as the copy a launch
  writes (§6a). GitHub is written as `<home>/.config/gh/hosts.yml` (`oauth_token`,
  `git_protocol: https`, and `user` when the account's login is known), so `gh` and a credential
  helper that reads it find the person's own token and nothing rides the environment. Every file is
  0600 and owned by the home directory's owner, as is every directory the write makes. One exec over
  the control connection per call writes and removes everything the call names; payloads go over
  stdin, never argv.
- **The home.** An absolute, normalised path of safe characters, never `/` or under `/workspace`
  (everything there is saved), reached without a symbolic link (checked in the executor, at write
  time). A put that names the home's `uid` and `gid` makes a missing home for them (0700, seeded
  from `/etc/skel`), so it can run beside the `useradd` that makes its user; without them a missing
  home answers 409 `home-unusable`. `/root` is allowed for the workspace's owner alone, for a
  launcher whose predicted per-person layout failed at prepare (processes nobody started run as
  root, so nobody else's login may be there); while a launch's own logins are at `$HOME` (a launch
  that named no home), `/root` is the launch's and a put or release there answers 409 `home-held`.
- **One person per home, while it is held.** `workspace_credential_homes` holds one row per
  (instance, home): the person, the account per provider whose copy is there, and the hold's
  generation. The first put names the home's person; a put naming anyone else is refused, 409
  `home-held`, and nothing is written. The same person may change an account or remove a provider.
  The home is held until it is released: `DELETE` removes every login file Core names in it
  (recorded or not: an unconfirmed write may have landed) and deletes the row; only then can the
  home be taken by another person. Release is idempotent (`released: false` when it held nothing);
  on a stopped executor it deletes the row only.
- **One row lock, bounded.** Every write into a home (a put, a release, a refresh push) runs inside
  one transaction that holds the home's row `FOR UPDATE`, behind a transaction-scoped advisory lock
  on the (instance, home) key so a home with no row yet is serialised too, across its
  control-channel write, and decides on the row as it is under the lock. Two first puts into one
  home take turns, and the second finds the first's person. A writer waits at most 20 s for another
  (`lock_timeout`), and the API runs at most two locked writes at once per workspace run and waits
  at most 10 s for one of them, so one hung executor holds back only its own workspace. Every such
  wait that runs out answers 409 `home-busy`: nothing was done, and trying again is safe.
- **A fence in the executor, under a lock in the executor.** A lock in the database cannot stop an
  exec the executor runs late: a write that timed out (and so released the database lock) keeps
  running, since sealantd ends a non-attached exec only when it exits. So every exec into a home
  presents a **fencing token**, drawn from a Postgres sequence under the home's row lock, and every
  hold has a generation, recorded on the row. The executor keeps, root's and outside every home and
  capture root, the home's **high-water mark** (`/run/sealant-homes/<key>.hw`, the highest token it
  has let through, never deleted) and its **marker** (`/run/sealant-homes/<key>.generation`, the
  hold's generation). Each script:
  1. reads every payload before it checks anything, so a script whose stdin arrives late decides
     only once it has all of it;
  2. takes the home's `flock` (`/run/sealant-homes/<key>.lock`) for at most 10 s (shorter than the
     15 s the caller waits for the exec, so contention answers `home-busy`, never unconfirmed), and
     holds it from the check to the last write, so a release or a take runs wholly before or wholly
     after it;
  3. refuses a token below the mark, then checks the marker: a take writes into a home with no
     marker or its own generation's (a launch delivered twice writes twice; a launch's take presents
     token 0, as nothing precedes it), and makes it; every later write writes only while the marker
     names its hold; a release removes the files and the marker only while the marker is absent or
     its own hold's (a home Core holds no record of is released whatever its marker says). It then
     raises the mark to its token.

  An exec issued before any later write, take or release into the home therefore writes nothing,
  whatever ran in between: a late write from an earlier hold, and a late release followed by a late
  take, alike (exit 76: a put answers 409 `home-held`, a push counts the home as no longer held). An
  image without `flock` or `setpriv` (util-linux) answers `home-unusable`; `/run` must be writable.

- **Inside the home, as its owner.** The person owns their home and can swap any entry in it for a
  link at any moment, so nothing inside a home that is not root's is touched with root's rights:
  root makes only the home directory itself (`chown -h`) and keeps the lock, mark and marker; every
  directory, file and removal inside the home runs as the home's owner
  (`setpriv --reuid --regid --clear-groups`). Whatever a planted link points at, the kernel refuses
  what the person could not do themselves, so root never writes, `chmod`s or `chown`s through it.
  That half starts from a clean environment, cleared while still root (`env -i` before `setpriv`): a
  fixed `PATH`, its flags and the person's own payloads, never the exec's environment (a token, the
  workspace's secret env), which the person could otherwise read through `/proc`. Before the hold
  changes, the script checks that it can drop to the owner at all; an executor that cannot answers
  `home-unusable` and leaves no marker.
- **Homes Core writes into.** A home's parent must be root's and not group- or world-writable
  (unless sticky), so the person cannot rename the home between the checks and the writes; a home
  root owns is refused unless it is `/root` (root's own, with the shared layout's links). Both
  answer `home-unusable`. A mark that is not a number (a write cut short) refuses every token, and
  the mark and the marker are written through a temporary file and a rename.
- **Images.** Every write into a home needs util-linux's `flock` and `setpriv` and a writable
  `/run`; the image probe (`metadata.imageProbe`) records both tools, and a managed image without
  them fails its build. Nix images have neither: they are one person's (the shared layout), and a
  home write there fails safe (`home-unusable`), writing nothing.
- **Unconfirmed writes.** A write that fails or times out can still land. A put into a home that
  held nothing records nothing and releases its own take once (files and marker); a late take
  landing after that leaves its marker, so the next take is refused until the home is released, and
  nobody else's process runs on it. A put into a held home leaves the record as it was (the same
  person's login either way). Both answer 502. A release that is not confirmed keeps the home held.
  A first take also removes every login file it does not write.
- **Links, and dotfiles.** No component of the home's path may be a link. In a home that is not
  root's, a login directory (`.claude`, `.codex`, `.config`, `.config/gh`) that is a link must lead
  inside the home: a dotfiles checkout that links `~/.claude` into `~/dotfiles/claude` keeps
  working, and the login lands in the checkout as Claude Code itself would put it there (keep it out
  of git). One that leads out of the home (into someone else's) is refused, 409 `home-unusable`, for
  writes and releases alike. Root's home keeps the shared layout's linked `~/.claude`. A link at a
  file's own name is removed, never followed. A put and the dotfiles that may link these directories
  should not race: apply the dotfiles first.
- **The push follows the homes.** `pushCredentialCopy` writes the new copy into every running launch
  that holds the account and, at the same time, into every home of a ready instance whose row holds
  the account, at most four homes at a time, each under its row lock and fence. Each home's copy is
  made from the account as stored when the home's lock is taken, not from the copy the push started
  with, so the older of two back-to-back refreshes never lands last. A home released or retaken
  since the listing is left alone.
- **The spec stays.** The blueprint's `credentialRefs` are unchanged; a put changes nothing a
  restart reads.
- **Only a running workspace.** No ready executor answers 409 `workspace-not-running`.

**Who may write.** A put names two people: the workspace's owner (`ownerUserId`, owner scope,
uniform 404) and the person whose logins are written (`onBehalfOfUserId`; every named account must
be theirs). Only a caller that may act for both may ask, so the three routes take only a service
key; the SSH gateway's secret and a user access token act for at most one person and are refused
(403) by the handler. The rule that a login is selected only for its owner's work stands: the
service key's product (Mend) puts a person's login only into that person's home, or into a
conversation home while that person's process is about to run there.

## 6d. A launch's own home (Oct 2026)

**Why.** In Mend's per-person layout the launcher's logins belong in the launcher's home, not at
`$HOME` (root's) or in the container's environment, and a cold launch makes no extra call for them.

- **`credentialsHome` on create** (`spec.runtime.credentialsHome = { path, uid, gid }`, SDK
  `create({ credentialsHome })`): the launch writes every login into that home: Claude and Codex as
  their files, GitHub as `.config/gh/hosts.yml`, so no `GITHUB_TOKEN`, `GH_TOKEN` or
  `CLAUDE_CODE_OAUTH_TOKEN` is in the environment. All of them go in one write, one exec. The home
  may not exist yet (its user is made after the launch), so the launch makes it, owned by
  `uid`:`gid`, mode 0700, seeded from `/etc/skel` as `useradd -m` would (it copies nothing into a
  home that already exists). Every file and every directory made for it is theirs, files 0600. The
  home follows §6c's rules (checked at create, a 400 otherwise; no link on the way, checked in the
  executor), and the launch takes it as a first put would, writing its marker. The launch's
  generation is derived from its run, so a launch delivered again (a worker restarted mid-launch, an
  adopted Pod or MicroVM) writes again under the same hold. Not on Cloudflare, whose bridge writes
  at `$HOME` only: a create there is refused (400), and the adapter refuses such a launch too.
- **Recorded as a held home.** Before the instance reads `ready` (when nobody can act on the home
  yet), the launch records the home for the workspace's owner with the accounts it wrote and the
  generation of its marker, as a put would (§6c), only if the home holds nothing, and only if the
  launch took it: a launch with no login writes nothing, and the home stays free for the first put.
  The record is retried briefly before a failure is logged. Refreshes reach it through the record,
  nobody else's logins are put there, and a release (`DELETE`) removes the files. That release is
  how Mend falls back to `/root` when a predicted per-person layout fails at prepare. The instance's
  `launch_credential_injections` entries name the home, so the per-instance push skips them: one
  write per refresh, never two. A failure to record is logged, never the launch's.
- **Cost.** No API call is added, and no exec: one exec writes every login, where a launch at
  `$HOME` runs one per file. The record is one short transaction in the worker.

## 6e. Running as a user, and an image's per-person capability (Oct 2026)

- **`user` on exec and sessions** (`POST /v1/workspaces/:id/exec { user }`,
  `POST /v1/sessions { user }`, SDK `exec(argv, { user })`, `sessions.open(argv, { user })`): a
  Linux user name or numeric uid. Core starts processes through sealantd, and no released sealantd
  can start one as another user yet (Mend ADR 0016 Delivery 5), so Core refuses with 409
  `user-unsupported` before anything starts, and never runs the process as the workspace's own user
  in its place. Wiring it through is a follow-up once sealantd's protocol carries it. An SDK sends
  `user` only to a control plane whose index reports `features.processUser` (kept five minutes, a
  failed read fifteen seconds), and refuses it client-side otherwise: an older control plane would
  decode the request without the field and run the process as the workspace's own user. Today's
  reports `false`.
- **The image's per-person capability.** The image build's probe (sealant#327) records on the
  build's metadata `imageProbe`: the tools (setuid `sudo`, `useradd`, `setfacl`, `setpriv`,
  `flock`), the sudoers rule, a writable passwd, the `mend` group, the reserved ids, and what its
  sealantd reports; a managed image that cannot run the layout, `setpriv` and `flock` included,
  fails its build. Core derives `personLayout = { status, missing, unknown, runtime, acl }` from it
  with `imagePersonLayoutSupport` (the runtime's `no_new_privs` counted: Kubernetes workspaces run
  with it, where `sudo` cannot raise a person) and the operator's `SEALANT_WORKSPACE_ACLS`. Anything
  not known is `unknown`, never `supported`. It is reported on every workspace read's
  `publishedImage`, for that workspace's runtime, so a launch's image is known with no extra call
  (SDK `launch.image` after `ready()`, `workspace.image()`), and before a create by
  `POST /v1/workspaces/image { spec }` (SDK `workspaces.inspectImage(options)`): the spec is planned
  exactly as the build plans it and the latest image published for the plan answers. That read
  creates nothing, and names the image only to the owner who built it. A caller avoids it with
  `workspaces.imageKey(options)`, a key for the capability (not the image's identity: the plan also
  reads the runtime's environment, roots and dotfiles) that the SDK computes from the spec alone
  (its image-shaping parts: harness, tooling, customization, lifecycle, access, target; not sources
  or runtime), with no call: Mend keeps what a launch's `launch.image` told it under that key and
  calls `inspectImage` only for a key it has not seen. On a MicroVM deployment the build's plan hash
  is its recipe's, which depends on worker configuration, so the read finds nothing and answers
  `unknown`; the capability is still on every read of a launched workspace. A reused image carries
  its build's probe forward.

## 6f. The capture owner map (Oct 2026)

- **`ownerMap` on a capture source**
  (`spec.sources.workspace.ownerMap = { gid, worktreeUid, people: [{ id, uid }] }`, SDK
  `source.ownerMap`): who owns what sealantd's restore writes (its ADR-0015 "Per-person saved
  directories", sealantd#145), and whether the executor is a per-person one (a root daemon whose map
  names someone leaves no-new-privileges unset, sealantd#148). Core delivers it as
  `SEALANT_CAPTURE_OWNER_MAP` in sealantd's JSON (`{"gid","worktree","people":{id: uid}}`, people in
  id order) from `captureOwnerMapEnv`, emitted after every other entry and empty without a map, so
  Docker, Kubernetes and MicroVM boot it alike. Cloudflare and Kubernetes refuse it at create and in
  their adapters (Kubernetes Pods run with `allowPrivilegeEscalation: false`, so no person's `sudo`
  could work).
- **One definition** of its shape, bounds and encoding in `@sealant/api-contracts/capture-owner-map`
  (`captureOwnerMapProblems`, `encodeCaptureOwnerMap`), used by the SDK's client-side refusal, the
  blueprint schema on every parse and the adapters: gid 40000, uids 40001–49999, ids that are one
  directory name, no id or uid twice, at most 256 people.
- **The creator's choice, and only through the source.** Whoever can create a workspace can set a
  map on it, and turns off no-new-privileges there; they already control its image, environment and
  commands, and no other principal's non-root process runs there. Every caller lane already refuses
  the `SEALANT_` prefix except a blueprint's legacy `runtime.env`, whose names must now be
  environment variable names (a name holding `=` would split on `docker run -e` into the map's
  name), which the API refuses for this name and every adapter drops; a bound ConfigMap's key of
  that name is dropped; and the entry comes last and empty without a map, which also overrides an
  image `ENV`.
- **Refused at launch on an image that may not apply it**: the worker reads the image probe the
  build recorded (or the reused build's) and fails the launch with `owner-map-unsupported` before
  the runtime row, the stager or the adapter is touched, unless its sealantd reported
  `restore.owner_map`. Unknown is refused, never launched on the hope: a daemon without it ignores
  the variable, restores everything root's and keeps no-new-privileges.
- **Fixed for the executor's life.** sealantd reads it at boot; a capture workspace is never
  restarted in place (its token is not retained), Docker's recovery restarts the same container and
  the MicroVM agent reuses the first boot's environment, so a recovery keeps it. A standby's claim
  (`capture.replan`) restores under the map the standby booted with; `expectedOwnerMap` on the
  re-plan (`null` for none) is compared with the map of the spec the workspace last launched from,
  as sealantd receives it, and a mismatch is refused (`409` `owner-map-mismatch`) before the daemon
  is reached. The daemon's `owner_map` flag is on the capture status (`ownerMap`).
- **Cost:** without a map, one empty entry in a capture launch's boot environment and an
  early-returning check; with one, a JSON string in the boot environment and one probe read the
  worker already holds.

## 6g. A person's dotfiles, applied as their user (Oct 2026)

- **`POST /v1/workspaces/:id/dotfiles { ownerUserId, user, home, repository?, archives? }`** (SDK
  `workspace.dotfiles.apply({ user, home, repository?, archives? })`): a person's dotfiles applied
  into their home of a running workspace, as their Linux user, after create (Mend ADR 0016 decision
  11: a person's first process in an executor someone else launched, and the fallback that applies
  the launcher's once their layout is known). The sources are a create's (`repository` cloned with
  no credential, `https://` only; caller-resolved `archives`, at most 4 of about 4 MiB each; the
  repository first, archives after, in order) and the applier is sealantd's `dotfiles.apply`
  (sealantd#147): chezmoi, stow or copy, every command as the user, files it writes itself given to
  them, then each tree's bootstrap (`./install.sh`, or `bootstrapCommand`) as one managed process of
  the user.
- **Checked before anything is applied, in one exec as root** (`buildDotfilesStageScript`): the user
  exists, is not root and is not in root's group (`user-unknown`, `user-root`), `home` is its passwd
  home (`home-mismatch`), an existing directory of the user's reached without a symbolic link
  (`home-unusable`), and the daemon reports `dotfiles.user` (`dotfiles-user-unsupported`); root and
  a home under `/workspace` are refused with 400 before the executor is reached. The same exec
  stages the archives under `/run/sealant-dotfiles/<runId>`, root's only, as the manifest and
  `<index>.tar.gz` files the daemon reads (the launch contract of `SEALANT_DOTFILES_ARCHIVE_DIR`);
  the bytes go over stdin, never argv. sealantd refuses root and a user in root's group on its own,
  and applies only into the user's passwd home.
- **A `dotfiles` run, queued on the run-exec queue** (a third framing beside harness and exec): the
  job names the user, the home, the staged directory and the repository, never an archive's bytes,
  and is deleted on pickup. The worker calls `dotfiles.apply` with the run's id as the execution,
  removes the staged directory once the daemon answers, and records the run's own events (the
  bootstrap's; another execution's and untagged events are not this run's) until the bootstrap
  exits. Its `processStarted` is the signal that every file is applied: `apply()` resolves at it, or
  at the run's end when there is no bootstrap, so Mend can start a joiner's agent beside
  `install.sh`; `bootstrap.wait()` resolves with the exit code (a datum, as for exec) and the
  output, read from the record. The run fails, with the daemon's words, when the apply is refused or
  does not answer within 10 minutes, and when the bootstrap runs past 30 minutes (it is stopped) or
  its exit goes unobserved. No changes are read: nothing of the worktree changed.
- **No secret is stored.** Arguments are never recorded (sealant#329): the bootstrap's
  `processStarted` keeps the count of its arguments only, and the staging exec's script holds no
  archive. A staged directory a job never reached is removed by the next staging after an hour.
- **Not covered:** applying as root into `/root` (sealantd's verb refuses root by design; a launch's
  own dotfiles at boot still go there), and a repository only the person's own identity can reach
  (the caller resolves it and sends it as an archive, as at create).

## 7. The `sealant` CLI — `apps/cli`

New workspace app `@sealant/cli`, bin `sealant`, built on `effect/unstable/cli` (Command/Flag/Prompt
— already in the pinned `effect` catalog version; no new deps beyond `@effect/platform-node`). Local
state in `~/.config/sealant/config.json` (api url, owner user id — defaults `http://localhost:4000`
/ `usr_local` matching the self-host seed). The CLI talks to the control-plane API directly, same
trust model as the web server. When control-plane API auth lands (API keys/sessions), the CLI grows
`sealant login`; the command namespace reserves it now.

```
sealant auth claude    # explains + optionally spawns `claude setup-token` (inherited stdio),
                       # then hidden-prompt paste of sk-ant-oat01-…, validates, uploads
sealant auth codex     # consent prompt → reads $CODEX_HOME/auth.json (offers to spawn
                       # `codex login` if absent), validates JSON, uploads
sealant auth github    # consent prompt → runs `gh auth token`, checks scopes via api.github.com
                       # (X-OAuth-Scopes; require repo, warn on missing workflow), uploads
sealant auth status    # table of connected accounts (provider, name, status, metadata)
sealant auth remove <provider> [--name]
sealant profiles list
sealant profiles bind <profile> --claude <name>|--codex <name>|--github <name> [--clear …]
```

Every auth command prints exactly what will be read/stored and where it will be used before touching
anything; `--yes` skips prompts for scripting.

## 8. Web settings

- `/_authenticated/settings/connected-accounts` (registered in `SETTINGS_SIDEBAR`): one card per
  provider — status, name, non-secret metadata, connect / reconnect / disconnect. Connect opens a
  provider-specific dialog: step-by-step instructions (`claude setup-token` / `codex login` /
  `gh auth token`) plus a paste field (token or auth.json contents). Web paste is equivalent to CLI
  upload — the user still ran the official tool; Sealant is just the storage target. A "or run
  `sealant auth <provider>`" hint links the CLI path.
- Profile bundle UI: `/_authenticated/profiles/$profileId/agents` — pick the connected account per
  provider for that profile (first profile subpage wired to live data).
- tRPC: new `connectedAccounts` router (protectedProcedure; strips `ownerUserId`, injects session
  user) → `CoreApiClient` methods → Zod mirrors in
  `packages/validators/src/api/connected-accounts.ts`.

## 9. SDK + internal use

- SDK (`packages/sdk`):
  `sandboxes.create({ …, credentials?: { profile?: string; claude?: boolean|string; codex?: boolean|string; github?: boolean|string } })`
  — `true` means "my default account", a string names one. Types + pass-through now (SDK core is
  still scaffold); no secret material ever crosses the SDK surface.
- Internal features ("summarize this run"): a control-plane service resolves the _owner's_ claude
  account and runs the **Claude Agent SDK** (which wraps the official binary) with
  `CLAUDE_CODE_OAUTH_TOKEN` set — inside the user's own deployment, on the user's own subscription.
  Never raw API calls. _Built (July 2026):_ the `/v1/inference/respond` endpoint +
  `sealant.inference.respond(...)` run exactly this path, with a caller-executed tool loop; internal
  features can reuse the same engine. _Extended (Aug 2026):_ codex accounts run the same endpoint
  through the **official Codex CLI** (`codex exec` against a private per-invocation `CODEX_HOME`;
  see §2 codex refresh) — tool-less v1: caller-defined tools stay claude-only until a parked-tool
  transport for codex ships, and `model` passes through verbatim on both arms.

## 10. Build order

1. `packages/credentials` (cipher, payload schemas, injection planner) + db schema/repos/
   migration + env schema + blueprint `credentialRefs` (foundation).
2. In parallel: API contracts/routes; worker resolver + docker file-injection + sync-back; CLI; web
   settings + profile agents page; SDK types.
3. Typecheck (`tsgo`), format, end-to-end review.
