# Local development

How to run the whole Sealant stack locally — web app, a real workspace, and SSH into it.

## Prerequisites

- **Docker** running (the worker + ssh-gateway drive it to build/launch workspaces).
- The **Nix dev shell** — `direnv allow` (or `nix develop`) gives Node 24 + pnpm.

## One-time setup

```bash
pnpm install
cp .env.example .env                                  # the dev defaults already point at local infra
pnpm ssh:setup:dev                                    # only if you want to SSH into workspaces
```

`pnpm ssh:setup:dev` appends the gateway vars — including a shared `WORKSPACE_SSH_GATEWAY_TOKEN` —
to **`.env`**. That's all it does: the gateway's host key autogenerates on first boot (into the
`gateway-keys` compose volume, same mechanism as the packaged self-host stack), and your client key
is your own — registered through the web app (first-run `/setup` wizard or **Settings → SSH keys**),
which also prints the `Host ws-*` block to paste into `~/.ssh/config`.

## Topology

Stateful infra + the **worker** + the **ssh-gateway** run in Docker; the **API** and **web** run on
the host (hot reload). `.env` is the single source of truth — every app reads it
(`dotenv -e ../../.env`), and compose passes it to the gateway via `env_file`.

| Service              | Where                                         | Port         |
| -------------------- | --------------------------------------------- | ------------ |
| postgres             | `docker compose up -d`                        | 5433         |
| api                  | `pnpm --filter @sealant/api dev`              | 4000         |
| web                  | `pnpm --filter @sealant/web dev`              | 3000         |
| worker + ssh-gateway | `docker compose --profile apps up -d --build` | gateway 2222 |

Postgres is the only always-on container. The job queue is pg-boss inside that database (`pgboss`
schema, created on first start) and built workspace images stay in your local Docker Engine, so
there is no broker and no registry.

## Run it

```bash
docker compose up -d                                  # infra
pnpm db:migrate                                       # schema
pnpm --filter @sealant/db db:seed                     # default owner (SDK/CLI; web users sign up)
pnpm --filter @sealant/api dev                        # :4000   (terminal 1)
pnpm --filter @sealant/web dev                        # :3000   (terminal 2)
docker compose --profile apps up -d --build           # worker + ssh-gateway
```

Open **http://localhost:3000**. With an empty database the web app routes you to the first-run
**`/setup` wizard**: create your account, paste your SSH public key, and copy the `Host ws-*` block
into `~/.ssh/config`. Then start a workspace — the worker builds the image into your local Docker
Engine and launches the container from it; wait until it's running/ready.

## SSH into a workspace

```bash
ssh ws-<workspaceId>
```

Works once the wizard's `Host ws-*` block is in your `~/.ssh/config` and your key is registered. No
generated identities, no `IdentityFile` pinning — the gateway authenticates whatever key your SSH
client offers against the keys registered to your account.

### Authorization (current ACL)

The gateway authorizes by **owner**: the principal your SSH key resolves to must equal the
workspace's `ownerUserId`. Keys resolve two ways, in this order:

1. **DB-registered keys** (the normal path): the gateway looks the offered key up in the `ssh_keys`
   table via the API (`POST /v1/ssh-keys/resolve-principal`) on every connection — no restart
   needed. Users register keys in the first-run `/setup` wizard, under **Settings → SSH keys**, or
   inline when creating a workspace.
2. **The static file `/keys/gateway_allowed_keys`** in the `gateway-keys` volume (operator
   break-glass): loaded once at gateway start; the trailing comment is the principal. Works even
   when the API is down, but requires a restart to change.

### SSH into SDK-created workspaces (`usr_local`)

The SDK stamps `ownerUserId=usr_local` (seeded by `db:seed`), so your web account's key won't
authorize you into SDK-created workspaces. Two options:

- **Recommended:** point the SDK at your real account — `SEALANT_OWNER_USER_ID=<your web user id>` —
  so SDK workspaces are owned by you and your registered key just works.
- **Break-glass:** add a **dedicated** keypair's public key to `/keys/gateway_allowed_keys` (in the
  `gateway-keys` volume) with the trailing comment `usr_local`, and connect with `-i` pointing at
  that key. Never list your main key there: the static file wins over the DB, so it would remap
  **all** your connections to `usr_local`. (`SEALANT_DEV_SSH_PUBLIC_KEY_FILE` on the seed does the
  DB-side equivalent for automation.)

## Releasing (packaged self-host)

Users install with `curl -fsSL …/install.sh | sh` (see README) — prebuilt images, no source build.
The pieces:

- **Images**: `.github/workflows/release.yml` releases a `vX.Y.Z` tag. `build` pushes each of
  `ghcr.io/sealant-sh/sealant-{api,worker,ssh-gateway,web}` for amd64 and arm64, each on a native
  runner, by digest with no tag. `merge` stages each image's index under this run's own tag,
  `staging-<run id>-<attempt>`, and `release-manifest` records every index and platform digest in
  the run's `release-manifest` artifact (kept 90 days). `selfhost-smoke` runs `install.sh` on amd64
  and on arm64 against those digests: it pulls each image by digest, tags that ID with the name
  install.sh expects, and fails unless every service runs that ID. `acceptance` passes only when
  both smoke legs and `workspace-e2e` passed; nothing publishes before it.
- **npm, from a job with no credential**: `pack` builds both packages, packs them with `pnpm pack`
  (the SDK's `workspace:*` dependency becomes the exact version), and normalizes each tarball once
  with `tooling/scripts/normalize-npm-tarball.mjs`: only allowlisted manifest fields, no scripts, no
  `.npmrc`, `gitHead` set to the commit. The release manifest records each tarball's sha512 and
  integrity. `pack` holds no `id-token`; nothing it runs can reach the npm credential.
- **Publishing, after acceptance**: `finalize-images` writes each `:<version>` from the accepted
  index. `npm` (environment `release`, `id-token: write` only) checks out nothing, installs nothing
  and runs no build tool: it checks that the artifact holds exactly the two tarballs, that each
  one's sha512 is the manifest's and that it is already normalized, publishes
  `@sealant/api-contracts` then `@sealant/sdk` from those bytes under `latest`, and reads each
  `dist.integrity` back. `github-release` waits for npm, and creates the release with
  `compose.selfhost.yaml` and `install.sh` attached and `--latest=false`. `promote` moves each
  `:latest` to the accepted index, then GitHub's latest release, which is what `install.sh` installs
  by default. `finalize-images`, `npm` and `promote` queue on one job-level lock,
  `sealant-release-channel` (`queue: max`, never cancelled).
- **Cutting a release**: push a `vX.Y.Z` tag. After the very first release, flip the four GHCR
  packages to public (one-time, per package) or anonymous pulls fail.
- **Every tag is read before it is written.** Only buildx's exact `ERROR: <ref>: not found` counts
  as absent; any other failed read stops the job before it writes. `finalize-images` reads all four
  `:<version>` first: a tag already at the accepted index is left alone, a tag at any other digest
  refuses ("Version X.Y.Z is spent: cut a new one"), and after a create a second read decides. A
  create that errored but left the accepted index passes with a warning.
- **The stable floor.** `npm` and `promote` each read it inside the lock before they write: the
  highest of npm `latest` for `@sealant/sdk` and `@sealant/api-contracts`, the tag of GitHub's
  latest release, and the `org.opencontainers.image.version` label on every platform of the four
  `sealant-*:latest`. Each marker must be a plain `X.Y.Z` (each part at most 9 digits); a marker
  that cannot be read or is malformed fails the job, and only a missing one adds nothing. Above the
  floor, `npm` publishes and `promote` moves every `:latest`. At the floor (a retry), `npm`
  republishes nothing and moves no dist-tag: each package npm holds must hold exactly this run's
  tarball, and a package it does not hold yet publishes only after the one before it verified as
  this run's (an attempt that stopped between the two packages); `promote` moves only the `:latest`
  not yet at this release's index. Below the floor both refuse and name the marker. So a backport,
  say 0.38.2 after 0.39.0, is refused on purpose, and `pins` refuses a tag below the highest stable
  tag before anything builds.
- **Frozen tags.** The `:X.Y` tags (`sealant-api:0.38` and the like) are no longer written: each
  stays at the last release that moved it, and nothing reads them. Read `:latest` or a full
  `:<version>` instead.
- **Re-running a stable release run.** Re-run failed jobs (`gh run rerun <id> --failed`); the run's
  manifest and tarballs are kept 90 days, its per-arch digests one day. What each job then does:
  - `build`, `merge`, the smoke or the workspace e2e failed: nothing final was written. A re-run
    stages under a new `staging-<run>-<attempt>` tag.
  - `finalize-images` wrote some `:<version>` tags: matching ones are left alone, absent ones are
    created, and a tag at another digest refuses before anything else is written.
  - `npm` published `@sealant/api-contracts` but not the SDK: the contracts are verified, not
    republished, and the SDK publishes.
  - `github-release` failed: only it re-runs (were `npm` re-run too, at the floor it only verifies
    and moves nothing). A published release with both assets is left alone; one missing an asset
    refuses (cut a new version); a draft for the tag is deleted and the release created again.
  - `promote` moved some `:latest` tags: the rest move, then GitHub's latest release.
  - A newer release published while this run waited: `npm` and `promote` refuse below the newer
    floor. This run's `:<version>` tags and its release (not latest) can still exist; no channel
    moves backwards.

  Never re-run all jobs once anything final was written: it builds new images and new tarballs, and
  `finalize-images` refuses the spent version, as `npm` fails on a version npm holds with other
  bytes. The way out is a new version.

- **An npm integrity mismatch** after a publish fails the job with `INCIDENT`: npm serves other
  bytes than this run packed, and `latest` already names that version. Do not republish or
  unpublish: deprecate the version, move `latest` back by hand only if the incident version still
  holds it, and cut a new version. Nothing after `npm` runs.
- **Staging tags** (`staging-<run id>-<attempt>`) stay on GHCR; nothing removes them yet, and
  nothing pulls them.
- **Dry run**: `gh workflow run release.yml --ref <branch> -f dry_run=true`. Its version is derived,
  never given: `<packages/sdk version>-dryrun.<run id>.<attempt>`. It builds every image to an
  archive (`archive-build`), assembles each index in a registry that lives on loopback inside
  `archive-merge`, packs the npm tarballs, writes the release manifest, runs the self-host smoke on
  amd64 and arm64 from the archives and the workspace e2e, and checks acceptance. It writes to no
  registry, npm included, and no job in it holds `packages: write` or an `id-token`: `build`,
  `merge`, `finalize-images`, `npm`, `github-release` and `promote` run on a tag push only. A pushed
  tag carrying `dryrun` is refused before anything builds, and every job that publishes first
  refuses any version that is not its own tag's plain `X.Y.Z`, however the version arrived.
- **A dry run proves the graph from any main**, including one that pins a sealantd prerelease.
  `pins` passes `--dry-run` to `tooling/scripts/check-release-pins.mjs` only for what the `release`
  job decided is a dry run: a dispatch, target `archive`, with the derived `-dryrun.` version. The
  script then reports the refusals that only say sealantd is a prerelease (a `sealantd-next` image
  pinned as `pin-sealantd.mjs` writes it, a prerelease `@sealant/runtime-*` range or lockfile
  resolution, and "cannot release with a sealantd prerelease") as warnings and lists them in the run
  summary under "A release would refuse:", and goes on. Every other check still fails a dry run: an
  image not pinned as `tag@sha256:<digest>`, a published package's `npm:` alias, a tag of the wrong
  shape, and a next build of the version on a commit the release leaves out. A `vX.Y.Z` tag refuses
  all of them, a sealantd prerelease included.
- **Still unproven until a watched stable release**: the first OIDC publish of a downloaded tarball
  (npm has only ever published stable Core with `pnpm publish`), the npm job reading GitHub's latest
  release with a token that holds only `id-token: write`, `finalize-images` and `promote` writing to
  GHCR, the GitHub release created with `--latest=false` and then moved by `promote`, the lock
  queueing across real runs, and the smoke pulling staged digests (a dry run accepts archives, not
  pulls). A dry run proves the builds, both arches' smoke, the manifest and the tarballs.
- **Local dry-run**: build the images with the same Dockerfiles
  (`docker build -f apps/<app>/Dockerfile -t ghcr.io/sealant-sh/sealant-<name>:0.0.0-dev .`), then
  `SEALANT_VERSION=0.0.0-dev SEALANT_COMPOSE_URL=$PWD/compose.selfhost.yaml sh install.sh`. Offset
  ports (`SEALANT_{WEB,API,SSH}_PORT`) let it coexist with the dev stack.
- **Prereleases from main** (ADR 0015 in sealant-sh/mend): every merge to `main` runs
  `.github/workflows/next.yml`, which publishes under **separate names**:
  `ghcr.io/sealant-sh/sealant-{api,worker,ssh-gateway}-next` and `@sealant/sdk-next` +
  `@sealant/api-contracts-next` (npm dist-tag `next`), one version, `B-next.N`: N is the commit's
  whole history (`git rev-list --count`), B the larger of what the pending changesets would release
  and the base of the highest next build already published above the last stable tag
  (`node tooling/scripts/next-version.mjs --package packages/sdk --npm @sealant/sdk-next`). Runs go
  one at a time, queued in push order (`queue: max`), so no merge's run is cancelled. The `next`
  trusted publisher is registered only on the two `-next` packages, so nothing in that workflow can
  publish `@sealant/sdk`. Images have no such boundary: a job with `packages: write` can push the
  stable images too (GHCR cannot scope it), and any of the repository's writers can run a branch
  workflow that requests it, code-owner review or not. The image jobs' actions and BuildKit are
  pinned, and Mend's bundle image pins the Core images by digest, which keeps out a tag moved after
  the pin. Mend pins a prerelease through an exact alias
  (`"@sealant/sdk": npm:@sealant/sdk-next@<version>`). `latest` on the stable packages moves only
  from a `vX.Y.Z` tag.
- **Next image tags are written once.** `image-tag` computes this run's index digest
  (`imagetools create --dry-run`) and reads `<image>-next:<version>` before writing it. At that
  digest the tag is left alone, so re-running failed jobs is safe while the run's artifacts are
  still kept; at any other digest the step refuses and writes nothing. A re-run of all jobs rebuilds
  the images and fails there if the rebuilt index differs (identical bytes are a no-op). Only
  buildx's exact `ERROR: <ref>: not found` counts as absent; any other read error fails the step.
  After a create, a second read decides: this run's digest passes, anything else fails; a create
  whose metadata names another digest only warns, since the second read decides. The step serializes
  nothing outside this workflow: a manual or external write to the tag is not covered.
- **Pinning sealantd**, a release or a prerelease, is one command:
  `node tooling/scripts/pin-sealantd.mjs <version>`. It writes the image as `tag@sha256:<digest>`
  (`ghcr.io/sealant-sh/sealantd:X.Y.Z@…`, or `sealantd-next:X.Y.Z-next.N@…`) into
  `packages/workspaces/src/buildkit/buildkit-builder.ts` and `apps/cf-bridge/Dockerfile`, sets the
  runtime packages in `packages/workspaces/package.json` exactly (aliases of the `-next` packages
  for a prerelease), and runs `pnpm install`. A stable release refuses to start while any sealantd
  reference lacks its digest or is a prerelease (`tooling/scripts/check-release-pins.mjs`); a dry
  run reports a prerelease and refuses a missing digest.
- **Releasing** follows one order across the three repositories (sealant-sh/mend
  `docs/operations/next-channel.md`). For Core: pin sealantd's release, merge, merge the Version
  Packages pull request, and **freeze main until the tag**; Mend proves that commit's next build;
  then tag it. The release refuses while an npm prerelease of the version came from a commit the tag
  leaves out, which is what a merge during the freeze produces.
- **Migrations in the packaged path** run from the api image (`node dist/migrate.js`, programmatic
  drizzle migrator + seed) — same journal table as dev `pnpm db:migrate`, so the histories are
  interchangeable.

## Gotchas

- **Worker / ssh-gateway run from a built image** — after a code change (or merging `main`), you
  must `docker compose --profile apps up -d --build <svc>`. A `restart` runs stale code.
- **`db:seed` needs `DATABASE_URL`** (no default). Run it from the Nix shell, or inline it.
- **Bare `pnpm dev`** starts _every_ workspace (web + docs both bind :3000, mobile/expo, …). Scope
  with `--filter`.
- **"Connection closed" right after the gateway banner** is authorization, not SSH: check
  `docker compose logs --tail=5 ssh-gateway`. Usually the principal ≠ owner (above), the key isn't
  registered (Settings → SSH keys), or the workspace isn't running.
- **"Host identification has changed"** means the gateway host key changed (e.g. you removed the
  `gateway-keys` volume). Run `ssh-keygen -R "[127.0.0.1]:2222"` and reconnect.
