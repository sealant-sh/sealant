# Workspace Composition Demo

This app is the thin runnable layer on top of `packages/os-integration-nix`.

It keeps the demo spec close to the commands you use locally, while the concrete Nix build logic stays in the shared OS integration package.

## Build The Demo Image

```bash
nix build "path:$PWD/packages/os-integration-nix#example-opencode-home-manager-image"
docker load < result
docker run --rm -it zweit-workspace-demo:opencode
```

Or from this workspace with pnpm:

```bash
pnpm --filter @zweit/workspace-composition-demo run build:image
docker load < result
docker run --rm -it zweit-workspace-demo:opencode
```

## Run The SSH Demo

```bash
docker run --rm -d \
  --name zweit-ssh-demo \
  -p 2222:2222 \
  -v "$HOME/.ssh/id_ed25519.pub:/run/keys/authorized_keys:ro" \
  -e ZWEIT_ENABLE_SSH=1 \
  -e ZWEIT_FOREGROUND_COMMAND='sleep infinity' \
  zweit-workspace-demo:opencode

ssh-keygen -R '[127.0.0.1]:2222'
ssh -p 2222 root@127.0.0.1
```

## Files

- `package.json`: small convenience scripts for building the Nix integration examples
- `nix/specs/demo.nix`: demo spec mirror used for documentation and future app wiring
