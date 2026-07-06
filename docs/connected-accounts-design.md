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

- **Only compliant acquisition:** the user runs `claude setup-token` themselves and pastes the
  resulting `sk-ant-oat01-…` token into Sealant. This is the officially documented headless/CI path
  (1-year, inference-scoped, **no refresh token — by design**). The CLI may _spawn_ the official
  `claude` binary interactively for convenience; the OAuth loop is entirely Anthropic's.
- **Hard don'ts (encoded in code, not just docs):** never read `~/.claude/.credentials.json` or the
  OS keychain; never initiate OAuth or embed Claude Code's client id; never call Anthropic's token
  or inference endpoints with the subscription token; never proxy Claude traffic through Sealant
  services. Anthropic blocked and sent legal requests to tools that spoofed the Claude Code client
  (Jan–Apr 2026).
- **Permitted consumption:** inject as `CLAUDE_CODE_OAUTH_TOKEN` where the **official Claude Code
  CLI / Agent SDK** runs. Help Center 15036540 explicitly covers "third-party apps that authenticate
  with your Claude subscription through the Agent SDK". Don't run `claude --bare` (ignores the env
  var). Internal features (run summaries) must go through the Agent SDK, never raw
  `POST /v1/messages`.
- **Refresh story:** none. Detect 401s → mark the account `invalid` → prompt re-auth. Record
  `connectedAt` and nudge near the 12-month mark.
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
- **Refresh story:** the official Codex CLI in the sandbox refreshes (proactively at ~8 days
  staleness, reactively on 401) and **rotates the refresh token**. We must sync the mutated
  auth.json back after runs, only ever overwrite our stored copy with a _newer_ `last_refresh`, and
  keep one live copy per credential (concurrent refreshes can permanently brick it). Seed the
  sandbox only at launch; never re-seed a stale copy over a fresh one.

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
  kind              text not null      -- "oauth-token" (claude) | "auth-json" (codex) | "gh-cli-token"
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

- `claude`: `{ token: "sk-ant-oat01-…" }`
- `codex`: `{ authJson: "<verbatim file contents>" }` — stored verbatim so we can re-materialize the
  exact file; parsed on write to validate shape and extract metadata.
- `github`: `{ token: "gho_…" }`

**Metadata examples** (never secret): claude `{ tokenSuffix, connectedVia }`; codex
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
  - claude → env `CLAUDE_CODE_OAUTH_TOKEN`
  - codex → file `$HOME/.codex/auth.json` (mode 0600)
  - github → env `GITHUB_TOKEN` + `GH_TOKEN`, optional git clone auth (§6)
- Self-host bootstrap: `install.sh` / compose generate `SEALANT_CREDENTIALS_KEY` once (follow-up in
  the packaging repo path; documented in the env schema description now).

Credential material **never** transits RabbitMQ job payloads and never appears in blueprints —
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
- **GitHub as clone auth:** when a sandbox's source has no GitHub App installation authRef but the
  launch has a github credential, the worker may use it as `http-token` clone auth
  (`x-access-token:<token>`) — this is what lets self-hosters skip the GitHub App entirely.
- 401/invalid detection from harness traffic is a follow-up (needs run-record signal plumbing); v1
  marks invalid only on sync-back/API-observed failures.

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
  features can reuse the same engine.

## 10. Build order

1. `packages/credentials` (cipher, payload schemas, injection planner) + db schema/repos/
   migration + env schema + blueprint `credentialRefs` (foundation).
2. In parallel: API contracts/routes; worker resolver + docker file-injection + sync-back; CLI; web
   settings + profile agents page; SDK types.
3. Typecheck (`tsgo`), format, end-to-end review.
