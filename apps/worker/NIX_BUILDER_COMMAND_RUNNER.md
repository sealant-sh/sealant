# Nix Builder Command Runner

This document explains how `apps/worker/src/create-nix-builder-command-runner.ts` works.

## Why this exists

The worker should orchestrate builds, not require Nix installed in the worker runtime itself. So
instead of running `nix build ...` as a local process, the worker executes commands inside the
`nix-builder` container through the Docker API.

That gives us:

- a single controlled Nix environment (`nix-builder`)
- no local Nix dependency in worker code paths
- containerized execution that is easy to replace per OS backend later

## End-to-end flow

1. Worker receives a job and selects `NixOsExecutor`.
2. `NixOsExecutor` calls the injected `commandRunner("nix", [...])`.
3. `createNixBuilderCommandRunner` connects to Docker via `/var/run/docker.sock`.
4. It finds the running compose service container with labels:
   - `com.docker.compose.project=<COMPOSE_PROJECT_NAME>`
   - `com.docker.compose.service=<NIX_BUILDER_SERVICE>`
5. It creates and starts a Docker exec in that container.
6. Docker returns one multiplexed stream; we split it into stdout/stderr.
7. When stream ends, we inspect exit code.
8. Exit code `0` returns `{ stdout, stderr }`; non-zero throws `nix-builder-command-failed`.

## Important env vars

- `DOCKER_SOCKET_PATH` (default `/var/run/docker.sock`)
- `COMPOSE_PROJECT_NAME` (default `sealant`)
- `NIX_BUILDER_SERVICE` (default `nix-builder`)

These come from `apps/worker/src/env.ts`.

## Why stream handling looks weird

Docker exec is not a normal child process pipe. It sends stdout and stderr over one stream with
framing metadata. `dockerode` exposes `modem.demuxStream(...)` to split this stream into separate
outputs.

The runner waits for the source Docker stream to complete, then reads captured buffers and checks
exit status via `exec.inspect()`.

## Troubleshooting

If jobs are stuck in `running`:

1. Confirm worker can see Docker socket:
   - `docker exec sealant-worker-1 ls /var/run/docker.sock`
2. Confirm nix-builder is running and discoverable by labels:
   - `docker compose --profile apps ps`
   - `docker inspect sealant-nix-builder-1 --format '{{json .Config.Labels}}'`
3. Confirm worker can execute in nix-builder:
   - `docker exec sealant-worker-1 sh -lc "nix shell nixpkgs#nodejs_24 -c sh -lc 'cd /workspace/apps/worker && node -e \"import(\\\"./src/create-nix-builder-command-runner.ts\\\").then(async m=>{const run=m.createNixBuilderCommandRunner({DOCKER_SOCKET_PATH:\\\"/var/run/docker.sock\\\",COMPOSE_PROJECT_NAME:\\\"sealant\\\",NIX_BUILDER_SERVICE:\\\"nix-builder\\\"}); const out=await run(\\\"nix\\\",[\\\"--version\\\"]); console.log(out.stdout);})\"'"`

## Notes for future Fedora/Arch support

The same pattern can be reused for an ansible-backed runner:

- discover `ansible-builder` by compose labels
- execute ansible/image build commands with Docker exec
- capture stdout/stderr and map non-zero exits to typed errors
