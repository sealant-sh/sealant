# SSH Gateway App

`@sealant/ssh-gateway` is the SSH routing gateway for sandbox access.

It accepts client SSH sessions on a single gateway host and resolves the internal sandbox runtime
SSH target via the API route:

- `GET /v1/sandboxes/{sandboxId}/ssh-target`

## Environment

- `SSH_GATEWAY_HOST` (default: `0.0.0.0`)
- `SSH_GATEWAY_PORT` (default: `2222`)
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

## Development

Bootstrap local env + keys (recommended before first run):

```bash
pnpm ssh:setup:dev
```

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

Or run the gateway process directly:

```bash
pnpm --filter @sealant/ssh-gateway dev
```
