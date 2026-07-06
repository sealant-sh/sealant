# SSH Gateway App

`@sealant/ssh-gateway` is the SSH routing gateway for workspace access.

It accepts client SSH sessions on a single gateway host and, instead of dialing an inner sshd,
drives the workspace's sealantd **control socket** (`/run/sealant/control.sock`) over a transport
bridge. SSH channels are mapped to control commands and daemon byte channels. It resolves the
control target via the API route:

- `GET /v1/workspaces/{workspaceId}/ssh-target`

## What this solves

- One stable SSH entrypoint instead of one host port per workspace.
- No per-workspace host port collisions.
- Stable host aliases for terminal + VS Code Remote SSH.
- A central place to add future auth/policy checks.

## High-level flow

1. User connects to gateway using alias `ws-<workspaceId>`.
2. Gateway authenticates the user key and resolves its principal id: first from the static allowlist
   `SSH_GATEWAY_ALLOWED_KEYS_FILE` (principal = key comment; operator break-glass), then by asking
   the API (`POST /v1/ssh-keys/resolve-principal`) to match the key's fingerprint against
   user-registered keys in the `ssh_keys` table (principal = key owner). DB keys work immediately
   after registration — no gateway restart.
3. Gateway extracts `<workspaceId>` from username (a routing hint only).
4. Gateway asks API `/v1/workspaces/{workspaceId}/ssh-target` with the gateway token + principal id;
   the API authorizes principal x workspace and returns the control target (container id).
5. Gateway opens one sealantd control connection (docker-exec + socat) and maps SSH channels:
   - `shell` -> `openSession{login}` + `attachSession{interactive}` (PTY stream)
   - `exec` -> `exec{/bin/bash -lc …, attach}` (exit status from the channel End)
   - `direct-tcpip` -> `openForward` (the VS Code Remote-SSH server path)
   - `subsystem:sftp` -> `openSftp`
   - `window-change` -> `resizePty`, `signal` -> `signalProcess`

In short: user connects once to gateway, gateway drives the daemon control protocol on their behalf.

## Environment

- `SSH_GATEWAY_HOST` (default: `127.0.0.1` — the gateway runs with host networking in compose, so
  binding wider exposes it publicly; opt in explicitly)
- `SSH_GATEWAY_PORT` (default: `2222`)
- `SSH_GATEWAY_BANNER` (default: welcome message shown during SSH handshake)
- `SSH_GATEWAY_HOST_KEY_PATH` (default: `/keys/ssh_gateway_host_key` — matches the `gateway-keys`
  compose volume; override for host runs)
- `SSH_GATEWAY_HOST_KEY_AUTOGENERATE` (default: `false` — when `true`, a missing host key is
  generated on first boot instead of failing startup; both the dev and self-host compose files use
  this with the persistent `gateway-keys` volume. An existing key is never overwritten.)
- `SSH_GATEWAY_ALLOWED_KEYS_FILE` (default: `/keys/gateway_allowed_keys`; optional — a missing or
  empty file is fine, user keys resolve via the API)
- `SSH_GATEWAY_WORKSPACE_USERNAME_PREFIX` (default: `ws`)
- `CORE_API_BASE_URL` (default: `http://127.0.0.1:4000`)
- `WORKSPACE_SSH_GATEWAY_TOKEN` (required)

The upstream-SSH env vars (`SSH_UPSTREAM_PRIVATE_KEY_PATH` / `SSH_UPSTREAM_READY_TIMEOUT_MS` /
`SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING`) are gone — the gateway no longer dials an inner sshd, and
no compose file sets them anymore.

## Username routing contract

Incoming usernames must follow:

- `<prefix>-<workspaceId>`

With default settings this means users connect as:

- `ws-<workspaceId>@<gateway-host>`

The gateway resolves `workspaceId` through the API and connects upstream to the runtime endpoint.

## Core files to review

- `apps/ssh-gateway/src/index.ts`
  - process startup and graceful shutdown wiring.
- `apps/ssh-gateway/src/env.ts`
  - env parsing + key file loading.
- `apps/ssh-gateway/src/gateway-server.ts`
  - SSH auth, session forwarding, and TCP/dynamic forwarding.
- `apps/ssh-gateway/src/workspace-target.ts`
  - workspace-id parsing and API lookup for runtime target.
- `apps/ssh-gateway/src/authorized-keys.ts`
  - parsing and matching of allowed public keys.

Related integration points outside this app:

- `apps/api/src/routes/workspaces/workspaces.handlers.ts`
  - internal `ssh-target` route + token guard.
- `apps/api/src/lib/workspace.ts`
  - runtime endpoint rewrite to gateway-facing endpoint.
- `apps/web/src/routes/_authenticated/workspaces/$workspaceId/index.tsx`
  - copied SSH command and VS Code/Cursor URI generation.
- `tooling/scripts/setup-ssh-gateway-dev.mjs`
  - dev gateway env bootstrap (`.env` managed block).

## Development

Bootstrap the shared gateway env (recommended before first run):

```bash
pnpm ssh:setup:dev
```

This writes a managed block to the repo `.env` with `WORKSPACE_SSH_GATEWAY_TOKEN` (generated once,
then preserved) plus HOST/PORT/USERNAME_PREFIX, so the API (host process) and the gateway container
agree. No key material is involved: the gateway host key autogenerates on first boot into the
`gateway-keys` volume, and client keys are registered through the web app (first-run `/setup` wizard
or Settings → SSH keys), which also prints the `Host ws-*` block for `~/.ssh/config`.

Run with Docker Compose app profile (starts `worker` + `ssh-gateway`):

```bash
docker compose --profile apps up -d --build
```

Run API on host in a separate terminal:

```bash
pnpm --filter @sealant/api dev
```

Then connect through the gateway:

```bash
ssh ws-<workspaceId>
```

This works once the `Host ws-*` block from the web app's `/setup` wizard is in `~/.ssh/config`; VS
Code Remote SSH resolves `ws-<workspaceId>` through the same block.

## VS Code notes

- VS Code Remote SSH relies on dynamic forwarding (`ssh -D ...`).
- Gateway implements TCP channel forwarding by mapping `direct-tcpip` to the daemon `openForward`
  command (a TCP connection opened from inside the workspace) so VS Code works.
- If auth fails, check that the alias resolves to user `ws-<workspaceId>` (not `127.0.0.1`).

Quick check:

```bash
ssh -G ws-<workspaceId> | grep -E '^(hostname|port|user|identityfile) '
```

Expected shape:

- `hostname 127.0.0.1` (or your configured gateway host)
- `port 2222`
- `user ws-<workspaceId>`

## Troubleshooting

- `Permission denied (publickey)`:
  - confirm your public key is registered (web: `/setup` wizard or Settings → SSH keys) or present
    in the `gateway-keys` volume's `gateway_allowed_keys` (break-glass).
  - if the API is down, only static-file keys authenticate — check the gateway logs for
    `principal lookup failed`.
  - confirm SSH config uses `User %n` for `Host ws-*`.
- `Connection refused`:
  - confirm `ssh-gateway` container is up and listening on `2222`.
- VS Code connects but fails port forward:
  - ensure gateway is on latest code with `tcpip -> forwardOut` handling.
- stale behavior:
  - rebuild + restart gateway: `docker compose --profile apps up -d --build ssh-gateway`.

Or run the gateway process directly:

```bash
pnpm --filter @sealant/ssh-gateway dev
```
