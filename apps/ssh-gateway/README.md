# SSH Gateway App

`@sealant/ssh-gateway` is the SSH routing gateway for sandbox access.

It accepts client SSH sessions on a single gateway host and resolves the internal sandbox runtime
SSH target via the API route:

- `GET /v1/sandboxes/{sandboxId}/ssh-target`

## What this solves

- One stable SSH entrypoint instead of one host port per sandbox.
- No per-sandbox host port collisions.
- Stable host aliases for terminal + VS Code Remote SSH.
- A central place to add future auth/policy checks.

## High-level flow

1. User connects to gateway using alias `sbx-<sandboxId>`.
2. Gateway authenticates the user key from `SSH_GATEWAY_ALLOWED_KEYS_FILE`.
3. Gateway extracts `<sandboxId>` from username.
4. Gateway asks API `/v1/sandboxes/{sandboxId}/ssh-target` for current runtime endpoint.
5. Gateway opens upstream SSH to sandbox runtime and forwards channels.

In short: user connects once to gateway, gateway handles the final hop.

## Environment

- `SSH_GATEWAY_HOST` (default: `0.0.0.0`)
- `SSH_GATEWAY_PORT` (default: `2222`)
- `SSH_GATEWAY_BANNER` (default: welcome message shown during SSH handshake)
- `SSH_GATEWAY_HOST_KEY_PATH` (default: `./.secrets/ssh_gateway_host_key`)
- `SSH_GATEWAY_ALLOWED_KEYS_FILE` (default: `./.secrets/authorized_keys`)
- `SSH_GATEWAY_SANDBOX_USERNAME_PREFIX` (default: `sbx`)
- `CORE_API_BASE_URL` (default: `http://127.0.0.1:4000`)
- `SANDBOX_SSH_GATEWAY_TOKEN` (required)
- `SSH_UPSTREAM_PRIVATE_KEY_PATH` (default: `./.secrets/id_ed25519`)
- `SSH_UPSTREAM_READY_TIMEOUT_MS` (default: `15000`)
- `SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING` (default: `false`)

## Username routing contract

Incoming usernames must follow:

- `<prefix>-<sandboxId>`

With default settings this means users connect as:

- `sbx-<sandboxId>@<gateway-host>`

The gateway resolves `sandboxId` through the API and connects upstream to the runtime endpoint.

## Core files to review

- `apps/ssh-gateway/src/index.ts`
  - process startup and graceful shutdown wiring.
- `apps/ssh-gateway/src/env.ts`
  - env parsing + key file loading.
- `apps/ssh-gateway/src/gateway-server.ts`
  - SSH auth, session forwarding, and TCP/dynamic forwarding.
- `apps/ssh-gateway/src/sandbox-target.ts`
  - sandbox-id parsing and API lookup for runtime target.
- `apps/ssh-gateway/src/authorized-keys.ts`
  - parsing and matching of allowed public keys.

Related integration points outside this app:

- `apps/api/src/routes/sandboxes/sandboxes.handlers.ts`
  - internal `ssh-target` route + token guard.
- `apps/api/src/lib/sandbox.ts`
  - runtime endpoint rewrite to gateway-facing endpoint.
- `apps/web/src/routes/_authenticated/sandboxes/$sandboxId/index.tsx`
  - copied SSH command and VS Code/Cursor URI generation.
- `tooling/scripts/setup-ssh-gateway-dev.mjs`
  - dev key/env setup + SSH config generation.

## Development

Bootstrap local env + keys (recommended before first run):

```bash
pnpm ssh:setup:dev
```

This script:

- Generates gateway host/upstream/client keys under `.secrets/`.
- Updates `.env` with gateway env values.
- Writes `~/.config/sealant/ssh_config` and `~/.config/sealant/known_hosts`.
- Tries to add `Include ~/.config/sealant/ssh_config` to `~/.ssh/config`.

If your environment prevents editing `~/.ssh/config` (common with immutable Nix setups), the script
prints the manual include line you need to add in your own SSH config management.

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
ssh sbx-<sandboxId>
```

`pnpm ssh:setup:dev` writes `~/.config/sealant/ssh_config` and ensures
`Include ~/.config/sealant/ssh_config` exists in `~/.ssh/config` so VS Code Remote SSH can resolve
`sbx-<sandboxId>` with the correct identity key.

## VS Code notes

- VS Code Remote SSH relies on dynamic forwarding (`ssh -D ...`).
- Gateway implements TCP channel forwarding through upstream SSH (`forwardOut`) so VS Code works.
- If auth fails, check that the alias resolves to user `sbx-<sandboxId>` (not `127.0.0.1`).

Quick check:

```bash
ssh -G sbx-<sandboxId> | grep -E '^(hostname|port|user|identityfile) '
```

Expected shape:

- `hostname 127.0.0.1` (or your configured gateway host)
- `port 2222`
- `user sbx-<sandboxId>`
- `identityfile .../.secrets/dev_client_key`

## Troubleshooting

- `Permission denied (publickey)`:
  - confirm your public key is in `.secrets/gateway_allowed_keys`.
  - confirm SSH config uses `User %n` for `Host sbx-*`.
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
