# Temporary Nix Composition Example

This folder shows the basic flow you asked about:

1. Start with user choices as data in `nix/demo-spec.nix`
2. Feed that spec into a reusable Nix function in `nix/mk-workspace.nix`
3. Produce:
   - a workspace environment derivation
   - a Docker/OCI image derivation

## Files

- `flake.nix`: wires the example together as a standalone flake
- `nix/demo-spec.nix`: example normalized user input
- `nix/mk-workspace.nix`: composition logic that turns the spec into build outputs

## What this example does

- Selects a harness (`opencode`, `codex`, or `claude-code`)
- Maps `extraPackages` to Nix packages
- Fetches a pinned external Nix config repo from the demo spec
- Imports your Home Manager module bundle from `modules/clis/default.nix` and Neovim from `modules/ides/nvim-config/neovim.nix`
- Pulls the real OpenCode binary from the upstream flake when `harness = "opencode"`
- Optionally starts `sshd` for pubkey-only access when `ZWEIT_ENABLE_SSH=1`
- Writes the normalized request to `/etc/zweit/spec.json` in the image
- Builds a runtime environment with `bash`, `git`, and the selected tools, then activates the imported Home Manager config at container startup
- Creates a Docker image whose entrypoint clones the target repo at startup and then launches the selected harness

The important split is:

- build time: tools, harness selection, pinned config repo fetch, Home Manager activation package, metadata file
- runtime: cloning the target repository

That keeps the image reusable while still letting each launch target a different repo.

## Build the environment derivation

```bash
nix build ./temp/nix-composition-example#workspace-env
```

## Build the Docker image

```bash
nix build ./temp/nix-composition-example#workspace-image
docker load < result
docker run --rm -it zweit-workspace-demo:opencode
```

If OpenCode needs provider credentials, pass them at runtime:

```bash
docker run --rm -it \
  -e OPENAI_API_KEY=... \
  zweit-workspace-demo:opencode
```

## SSH into the container

Start the container with SSH enabled, publish port `2222`, and mount a public key file:

```bash
docker run --rm -d \
  --name zweit-ssh-demo \
  -p 2222:2222 \
  -v "$HOME/.ssh/id_ed25519.pub:/run/keys/authorized_keys:ro" \
  -e ZWEIT_ENABLE_SSH=1 \
  -e ZWEIT_FOREGROUND_COMMAND='sleep infinity' \
  zweit-workspace-demo:opencode
```

Then connect from the host:

```bash
ssh -p 2222 root@127.0.0.1
```

The default mounted public key path is `/run/keys/authorized_keys`. You can override it with `ZWEIT_SSH_AUTHORIZED_KEYS_FILE`, and you can override the internal container port with `ZWEIT_SSH_PORT`.

## How to adapt this pattern

In the real backend, `nix/demo-spec.nix` would not be handwritten. Your API would:

1. validate and normalize user input
2. write a small generated spec file
3. call a shared function like `mk-workspace.nix`
4. build the selected output (`env`, `image`, or both)

That lets you keep all Nix logic in one place and only generate data per request.

The demo spec now pins the external config repo revision and lists the imported module paths, so the config source is data in the spec rather than hardcoded into the image builder.
