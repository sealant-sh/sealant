# Packaging & one-line install — implementation plan

**Status:** plan, July 2026. Synthesized from codebase exploration + two independent designs
(fable-5 plan agent, gpt-5.5 codex review). Code claims below were verified in source by the plan
agent.

## Context

Goal: a user with **only Docker** (daemon + compose v2) installs the full Sealant Core stack with

```sh
curl -fsSL https://raw.githubusercontent.com/get-sealant/sealant/main/install.sh | sh
```

then opens `http://localhost:3000`, signs up, adds their SSH key in the UI, creates a sandbox, and
can `ssh sbx-<id>@localhost -p 2222` into it. No firewall changes, no git/node/nix on the host, no
source builds.

What blocks that today:

- `install.sh` clones the repo and builds from source (`compose.selfhost.yaml` + `--build`).
- `compose.selfhost.yaml` lacks **web** and **ssh-gateway** entirely (self-host cannot SSH; there is
  no auth surface since Better Auth lives in the web app).
- `apps/web` has no Dockerfile and no production serve entry (TanStack Start build emits
  `dist/client` + a fetch-handler `dist/server/server.js`, no listener).
- The migrate one-shot builds the api Dockerfile `builder` target from source.
- SSH key material only comes from the dev script (`tooling/scripts/setup-ssh-gateway-dev.mjs`); the
  gateway hard-requires `SSH_GATEWAY_HOST_KEY_PATH` with no generation path.
- No release CI in this repo (sealantd next door has the pattern to copy).

Facts that make this easy (verified in code):

- **The browser never calls the core API** — only server-side tRPC context does, and
  `getCoreApiBaseUrl` falls back to `process.env` at runtime
  (`apps/web/src/lib/api/core-api-client.ts:72`). Prebuilt web images work; no VITE build-time
  baking problem as long as CI never sets `VITE_API_URL`.
- **`SSH_UPSTREAM_*`, `gateway_upstream_key`, and the worker `authorized_keys` are dead code** on
  this branch (nothing reads them; the worker only checks `DEFAULT_SSH_AUTHORIZED_KEYS_FILE` for
  defined-ness in `docker-runtime-adapter.ts:600-621`). The packaged stack needs exactly **two** SSH
  secrets: gateway host key + `SANDBOX_SSH_GATEWAY_TOKEN`.
- **Host networking is dev-only compensation** for the API running on the host. In the packaged
  compose everything is a container: gateway→api goes over bridge DNS (`http://api:4000`), never
  touching the host firewall. Dev `compose.yaml` keeps `network_mode: host` untouched.
- `seed.ts` already skips dev-key registration when the file is absent
  (`packages/db/src/seed.ts:45-63`).
- drizzle-orm 1.0.0-rc.3's programmatic `migrate()` reads the committed folder-per-migration layout
  — migrations can run from a prebuilt image without drizzle-kit or source.
- Zot config is 18 static lines — inlinable via compose `configs: content:` (needs compose ≥
  2.23.1).

## Decisions (incl. where the two designs disagreed)

| Decision             | Choice                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image names          | `ghcr.io/get-sealant/sealant-{api,worker,ssh-gateway,web}`, public                                                                                                                                                        | Repo is `get-sealant/sealant`; sealantd owns `ghcr.io/get-sealant/sealantd`                                                                                                                                                                          |
| Gateway host key     | **Auto-generate on first boot in the gateway** (opt-in env `SSH_GATEWAY_HOST_KEY_AUTOGENERATE=true`, key persisted in a named volume)                                                                                     | vs codex's ssh-keygen bootstrap container: same no-silent-rotation property (generate only when missing), one fewer service/image, no ssh-keygen dependency (node `generateKeyPairSync("ed25519")`). Fail-fast default preserved for non-compose use |
| Seed `usr_local`     | **Keep in packaged migrate** (default on)                                                                                                                                                                                 | SDK flows key off `usr_local`; it's inert for web users. Codex wanted opt-in — revisit at identity convergence                                                                                                                                       |
| Compose distribution | **Attach `compose.selfhost.yaml` as a GitHub Release asset**; raw-at-tag URL as fallback                                                                                                                                  | We need `gh release create` anyway for `releases/latest` resolution; assets are immutable and allow future manifest/checksums                                                                                                                        |
| Zot config           | Inline via `configs: content:`; installer enforces compose ≥ 2.23.1                                                                                                                                                       | Single-file distribution beats a second download                                                                                                                                                                                                     |
| Migrate ordering     | Installer runs `docker compose run --rm migrate` explicitly; compose also keeps `depends_on: service_completed_successfully` for manual `up` users                                                                        | One-shot services are awkward across repeated `up`s                                                                                                                                                                                                  |
| Default binds        | `127.0.0.1` for web (3000), api (4000), gateway (2222); zot **always** loopback (5000, host daemon push/pull path). `SEALANT_BIND_HOST` opt-out for web/api/gateway                                                       | Plain-http auth cookies; local-first v1                                                                                                                                                                                                              |
| Install dir          | `~/.sealant` (override `SEALANT_INSTALL_DIR`), holds `compose.yaml` + `.env` (0600)                                                                                                                                       |                                                                                                                                                                                                                                                      |
| Platform scope       | **Linux hosts fully supported in v1; Docker Desktop best-effort/untested**                                                                                                                                                | `/run/sealant/sockets` + docker.sock semantics live inside Docker Desktop's VM — plausibly consistent but unverified. Document, don't promise                                                                                                        |
| Versioning           | Git tag `vX.Y.Z` is the single source of truth (sealantd model). Installer resolves `releases/latest` once, pins `SEALANT_VERSION=X.Y.Z` into `.env`; re-runs stay pinned; `SEALANT_VERSION=latest` re-resolves (upgrade) |                                                                                                                                                                                                                                                      |

## Phase 0 — Minimal productization code changes

1. **Gateway host-key autogen** — new `apps/ssh-gateway/src/host-key.ts` called from `index.ts`
   before env parse: if `SSH_GATEWAY_HOST_KEY_AUTOGENERATE=true` and the file at
   `SSH_GATEWAY_HOST_KEY_PATH` is missing → `generateKeyPairSync("ed25519")`, write PKCS#8 PEM 0600
   (mkdir -p parent), log fingerprint. Schema entry in `packages/validators/src/env.ts`
   (`sshGatewayCoreEnvSchema`) + test.
2. **Secure-cookie fix** — `packages/auth/src/server.ts:87`: derive `useSecureCookies` from the
   `BETTER_AUTH_URL` scheme (https ⇒ true) instead of `NODE_ENV === "production"`. Without this,
   packaged sign-in breaks on Safari over plain-http localhost. (Both designs found this
   independently.)
3. **Seed refactor** — extract `runSeed(databaseUrl)` into `packages/db/src/seed-core.ts`
   (bundle-friendly: no `import.meta.url` repo-root resolution; dev key path becomes optional env
   `SEALANT_DEV_SSH_PUBLIC_KEY_FILE`). `seed.ts` stays as the tsx CLI wrapper.
4. **Multi-entry bundling** — `tooling/scripts/bundle-app.mjs`: accept `BUNDLE_ENTRIES`
   (comma-separated, default `src/index.ts`), switch `outfile` → `outdir` when > 1.
5. **API migrate entrypoint** — new `apps/api/src/migrate.ts`: `drizzle-orm/node-postgres`
   programmatic `migrate(db, { migrationsFolder: env DRIZZLE_MIGRATIONS_DIR ?? "/app/drizzle" })`
   then `runSeed(DATABASE_URL)`; exit non-zero on failure. api `build` script sets
   `BUNDLE_ENTRIES=src/index.ts,src/migrate.ts`. **Verify during implementation:** drizzle-kit
   `migrate` (dev) and programmatic `migrate()` (packaged) share the same journal table so histories
   don't diverge.
6. **Server-only API URL for web** — prefer `process.env.CORE_API_BASE_URL` over `VITE_API_URL` in
   `getCoreApiBaseUrl` (server side), so a build-time-baked VITE value can never shadow runtime
   config. CI must never set `VITE_API_URL`.
7. **Vestigial cleanup** — drop `SSH_UPSTREAM_PRIVATE_KEY_PATH` /
   `SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING` from `compose.yaml`; update
   `apps/ssh-gateway/README.md` + `docs/ssh-onboarding-current-state.md`. (Keep
   `gateway_upstream_key` generation in the dev script only if the deprecated `host-published` path
   still wants it — flag in PR.)

## Phase 1 — Images

- **`apps/web/Dockerfile` (new)** — builder: pnpm install + `pnpm --filter @sealant/web build` (with
  `VITE_API_URL` unset), then pruned prod node_modules via
  `pnpm --filter @sealant/web deploy --prod` (fallback if pnpm-10 `deploy` misbehaves in the
  workspace: esbuild-bundle the serve entry). Runtime: `node:24-bookworm-slim`, `USER node`, copies
  `dist/` + node_modules + serve entry, `ENV PORT=3000`.
- **`apps/web/server.mjs` (new, ~40 lines)** — `node:http` listener: static-serve `dist/client`
  (immutable caching for hashed assets; `srvx` is already in the lockfile) and forward everything
  else to `(await import("./dist/server/server.js")).default.fetch` via `srvx/node` request/response
  bridging. Respects `PORT`. Add a `start` script.
- **`apps/api/Dockerfile`** — runtime stage adds
  `COPY --from=builder /app/packages/db/drizzle ./drizzle` (dist now has `index.js` + `migrate.js`).
- **All Dockerfiles** — switch `pnpm install --no-frozen-lockfile` → `--frozen-lockfile`
  (reproducible releases; repo rule: never touch the lockfile).
- **worker/gateway Dockerfiles** — no other changes needed.

## Phase 2 — `compose.selfhost.yaml` rewrite (fully self-contained)

- All app services `image: ghcr.io/get-sealant/sealant-<name>:${SEALANT_VERSION:?}` (no `build:`).
- Top-level `configs:` with inline zot config `content:`; zot keeps `127.0.0.1:5000:5000`.
- `migrate`: api image, `command: ["node", "dist/migrate.js"]`, `restart: no`.
- `api`: adds `SANDBOX_SSH_GATEWAY_TOKEN`,
  `SANDBOX_SSH_GATEWAY_HOST=${SEALANT_SSH_HOST:-localhost}`,
  `SANDBOX_SSH_GATEWAY_PORT=${SEALANT_SSH_PORT:-2222}`, `SANDBOX_SSH_GATEWAY_USERNAME_PREFIX=sbx`
  (the UI renders the ssh command from these). Ports
  `${SEALANT_BIND_HOST:-127.0.0.1}:${SEALANT_API_PORT:-4000}:4000`.
- `worker`: adds `SANDBOX_CONTROL_SOCKET_HOST_DIR=/run/sealant/sockets` + rw bind mount of that host
  path (required — without it endpoints come back `docker-exec://`, unusable by the socketless
  gateway). Docker socket becomes `${DOCKER_SOCKET_PATH:-/var/run/docker.sock}` (rootless-docker
  friendliness). Drop dev-only `DEFAULT_SSH_*` extras.
- `ssh-gateway` (new): bridge network; `SSH_GATEWAY_HOST=0.0.0.0` **inside** the container (binding
  127.0.0.1 in a bridge container would make the published port unreachable), published
  `${SEALANT_BIND_HOST:-127.0.0.1}:${SEALANT_SSH_PORT:-2222}:2222`;
  `CORE_API_BASE_URL=http://api:4000`; `SSH_GATEWAY_HOST_KEY_PATH=/keys/ssh_gateway_host_key` +
  `SSH_GATEWAY_HOST_KEY_AUTOGENERATE=true`; volumes `gateway-keys:/keys` +
  `/run/sealant/sockets:/run/sealant/sockets:ro`. **No docker.sock, no allowlist file** (security
  invariants preserved; break-glass allowlist documented as an optional bind mount in comments).
- `web` (new): `NODE_ENV=production`, `PORT=3000`, `DATABASE_URL`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL=${SEALANT_WEB_URL:-http://localhost:3000}`,
  `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000`,
  `CORE_API_BASE_URL=http://api:4000`; ports
  `${SEALANT_BIND_HOST:-127.0.0.1}:${SEALANT_WEB_PORT:-3000}:3000`; healthcheck on `/`. Healthcheck
  also added to the gateway.
- Secrets come from `.env` with `:?`-style guards (`${SANDBOX_SSH_GATEWAY_TOKEN:?run install.sh}`) —
  no fallback passwords for token/auth secret.
- Volumes: `postgres-data`, `zot-data`, `gateway-keys`. Project name stays `sealant`.

## Phase 3 — `install.sh` rewrite

POSIX sh, no git. Hosted at `raw.githubusercontent.com/get-sealant/sealant/main/install.sh`.

1. Preflight: `docker` present + daemon reachable, `docker compose version` ≥ 2.23.1, `curl`.
2. Resolve version: `SEALANT_VERSION` env override, else GitHub API `releases/latest` `tag_name` via
   `sed` (no jq).
3. Download the release-asset `compose.selfhost.yaml` → `$INSTALL_DIR/compose.yaml` (`~/.sealant`;
   overwrite = upgrade; fallback raw-at-tag URL). Support `SEALANT_COMPOSE_URL` / local-file
   override for testing.
4. `.env` bootstrap, idempotent: generate missing `SEALANT_DB_PASSWORD`,
   `SEALANT_RABBITMQ_PASSWORD`, `SANDBOX_SSH_GATEWAY_TOKEN`, `BETTER_AUTH_SECRET`
   (`head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`), `chmod 600`. **Never overwrite existing
   values**; only the `SEALANT_VERSION=` line is upserted.
5. `docker compose pull` → `docker compose run --rm migrate` → `up -d --remove-orphans`.
6. Health-wait: api `/healthz`, then web `/` 200.
7. Summary output: open `http://localhost:3000` → sign up → Settings → SSH keys → create sandbox →
   `ssh sbx-<sandbox-id>@localhost -p 2222`. Upgrade: re-run installer with
   `SEALANT_VERSION=latest`. Uninstall:
   `docker compose --project-directory ~/.sealant down -v && rm -rf ~/.sealant` (+ note about
   `docker ps` cleanup of sandbox containers on the host daemon).

## Phase 4 — CI: `.github/workflows/release.yml` (modeled on sealantd's)

- Trigger `push: tags: ["v*.*.*"]`; `permissions: contents: write, packages: write`.
- `image` job, `strategy.matrix` over the four images (context `.`, dockerfile per app):
  `actions/checkout@v7` → `docker/setup-qemu-action@v4` → `useblacksmith/setup-docker-builder@v1` →
  `docker/login-action@v4` (ghcr, `GITHUB_TOKEN`) → `docker/metadata-action@v6` (tags: semver
  `{{version}}`, `{{major}}.{{minor}}`, `latest`) → `useblacksmith/build-push-action@v2`
  (`platforms: linux/amd64,linux/arm64`, `provenance: false`).
  `runs-on: blacksmith-4vcpu-ubuntu-2404`. `VITE_API_URL` never set.
- `release` job: `gh release create "$GITHUB_REF_NAME" compose.selfhost.yaml --generate-notes` (this
  is what makes `releases/latest` resolve).
- `selfhost-smoke` job (`needs: image`, ubuntu-latest): run
  `SEALANT_VERSION=${GITHUB_REF_NAME#v} sh install.sh` with the checkout's compose file, assert
  healthz + web 200 + key registration + sandbox create +
  `ssh -o StrictHostKeyChecking=accept-new -p 2222 sbx-<id>@localhost true`.
- After the first publish: flip all four GHCR packages to **public**.

## Phase 5 — Docs

- README: quickstart one-liner front and center; upgrade/uninstall section.
- DEVELOPMENT.md: unchanged dev flow, note the release path.
- Update `docs/ssh-onboarding-current-state.md` where this plan invalidates it (§7 self-host,
  vestigial keys).

## Verification (end-to-end, before first tag)

1. Build all four images locally with the same Dockerfiles
   (`docker build -f apps/<app>/Dockerfile -t ghcr.io/get-sealant/sealant-<name>:0.0.0-dev .`).
2. `SEALANT_VERSION=0.0.0-dev SEALANT_COMPOSE_URL=<local file> sh install.sh` on a clean host (or
   after `down -v`).
3. Full flow: signup at localhost:3000 → add a real public key in Settings → create sandbox →
   `ssh sbx-<id>@localhost -p 2222` gets a PTY. Confirm the gateway container has no docker.sock.
4. Idempotency: re-run installer (no secret churn, data intact); uninstall; re-run migrate on an
   existing DB (journal-table compatibility check from Phase 0.5).
5. Dev regression: `compose.yaml` + `pnpm ssh:setup:dev` flow still works (host networking
   untouched) after the vestigial cleanup.
6. `pnpm format:fix` + `pnpm typecheck` after all code changes.

## Risks

- pnpm 10 `deploy --prod` semantics for the web runtime node_modules (fallback: bundle serve entry).
- drizzle-kit vs drizzle-orm migrator journal-table compatibility (test both against one DB).
- Compose ≥ 2.23.1 requirement for inline `configs:` (installer checks and says so).
- `/run/sealant/sockets` is tmpfs — cleared on host reboot; `docker compose up -d` after reboot
  recreates it (document).
- Docker Desktop (macOS) control-socket path semantics unverified — Linux-first v1.
- GHCR packages default private; first release requires the manual public flip.

## Explicitly deferred (from docs/ssh-onboarding-current-state.md)

Identity convergence (`usr_local` vs better-auth users), file-wins allowlist precedence,
single-active-owner fingerprint UX, `~/.config/sealant/ssh_config` generator productization, TLS /
remote-server installs (`SEALANT_PUBLIC_URL` profile + secure cookies + reverse proxy), custom
install domain (e.g. `get.sealant.dev` alias), release manifest checksums, native arm64 runners.
