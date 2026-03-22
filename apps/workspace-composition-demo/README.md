# Workspace Composition Demo

This app is currently a placeholder while the dedicated Nix integration is offline.

The BuildKit-backed Arch/Fedora path lives in `packages/os-integration-buildkit`.

## Build The Demo Image

Demo build scripts are temporarily disabled.

## Run The SSH Demo

```bash
docker run --rm -d \
  --name sealant-ssh-demo \
  -p 2222:2222 \
  -v "$HOME/.ssh/id_ed25519.pub:/run/keys/authorized_keys:ro" \
  -e SEALANT_ENABLE_SSH=1 \
  -e SEALANT_FOREGROUND_COMMAND='sleep infinity' \
  sealant-workspace-demo:opencode

ssh-keygen -R '[127.0.0.1]:2222'
ssh -p 2222 root@127.0.0.1
```

## Files

- `package.json`: placeholder scripts while Nix integration is offline
- `nix/specs/demo.nix`: historical demo spec mirror kept for future rework
