# Distro Composition

This package contains an Ansible playbook that builds distro-targeted Docker images with a selected set of preinstalled development dependencies.

## Supported distros

- `arch`
- `fedora`

## Supported dependencies

- `nodejs`
- `pnpm` (installed through Corepack; `nodejs` is auto-included)
- `neovim`
- `postgresql` (binaries only)

## Build an image

From the repo root:

```bash
ansible-playbook packages/distro-composition/playbooks/site.yml \
  -e '{"target_distro":"arch","selected_dependencies":["nodejs","pnpm","neovim","postgresql"],"image_name":"zweit-dev","image_tag":"arch"}'
```

The playbook renders a Dockerfile under `packages/distro-composition/playbooks/.build/` and then runs `docker build`.

## TypeScript wrapper API and CLI

This package also includes a TypeScript wrapper around the playbook:

- API: `packages/distro-composition/src/build-image.ts`
- CLI: `packages/distro-composition/src/cli.ts`

Run the CLI from the workspace:

```bash
pnpm --filter @zweit/distro-composition run build:image -- --distro arch --deps nodejs,pnpm,neovim --image zweit-dev --tag arch
```

Or use the convenience scripts:

```bash
pnpm --filter @zweit/distro-composition run build:image:arch -- --deps nodejs,pnpm
pnpm --filter @zweit/distro-composition run build:image:fedora -- --deps nodejs,postgresql --smoke-test
```

Minimal API example:

```ts
import { buildDistroImage } from "./packages/distro-composition/src/build-image.ts";

await buildDistroImage({
  targetDistro: "fedora",
  dependencies: ["nodejs", "pnpm", "postgresql"],
  imageName: "zweit-dev",
  imageTag: "fedora",
  runSmokeTest: true
});
```

## Optional smoke test

Set `run_smoke_test=true` to run dependency version checks after the image is built.

```bash
ansible-playbook packages/distro-composition/playbooks/site.yml \
  -e '{"target_distro":"fedora","selected_dependencies":["nodejs","pnpm"],"image_name":"zweit-dev","image_tag":"fedora","run_smoke_test":true}'
```
