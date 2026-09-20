# Workspace image builders — every runtime builds the blueprint's image, away from the control plane

Status: proposed 2026-09-20. Scope: `sealant-sh/sealant`, with one gate item in `sealant-sh/mend`.

## 0. The two rules this design serves

1. **A blueprint's image customisation works on every runtime.** The operating system (a distro
   family, or the project's own base image), the packages and the default shell are part of what a
   project is. A runtime that ignores them runs a different project. This holds for every compute
   adapter Sealant has and every one it adds. Setup commands are not part of a blueprint: a control
   plane such as Mend runs them inside the live workspace, which already works on every runtime.
2. **A blueprint's image customisation never runs where it can read the control plane's credentials
   or harm it.** A custom base image is chosen by whoever owns the project, and the build runs steps
   inside it: its `/bin/sh`, its package manager, its `ONBUILD` triggers. On a multi-tenant control
   plane the owner is a stranger.

## 1. Current state (inspected on `origin/main`, 2026-09-20)

- The worker builds and publishes an image for every workspace in phase A of
  `process-workspace-build-job.ts`, then selects the runtime adapter in phase B. There is one
  `imageBuilder` for the whole worker: the Kubernetes BuildKit builder when
  `SEALANT_K8S_BUILD_NAMESPACE` is set, the host Docker builder otherwise. `RuntimeAdapter` says
  nothing about images.
- **MicroVM breaks rule 1.** The adapter boots `SEALANT_MICROVM_IMAGE_ARN`, one image registered by
  hand with `microvm-image/build-image.sh`. It never reads the image phase A built; its own e2e
  passes a fixture named `unused`. Every MicroVM workspace runs the same Amazon Linux image whatever
  its blueprint says, and the build it ignored still ran.
- **The host Docker builder breaks rule 2 for tenants.** `RUN` steps share the control plane's
  kernel and Docker daemon, and on EC2 a build step can reach the instance metadata service. That is
  acceptable on a single-user install, where the tenant is the operator.
- `build-image.sh` copies `sealantctl` out of the released sealantd image. The released
  `ghcr.io/sealant-sh/sealantd:0.18.0` holds `sealantd` and `socat` and no `sealantctl`, so the
  script fails against any released daemon. The AWS POC used a private candidate image.

## 2. What was measured (account 954648881795, eu-central-1, 2026-09-20)

Four throwaway images, each deleted afterwards, with their objects and one temporary IAM role.

| Question                                                         | Observation                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Must a MicroVM root filesystem be Amazon Linux?                  | No. The stock recipe with `FROM public.ecr.aws/docker/library/fedora:41`, plus `ripgrep` and `bat` from Fedora's repositories and a setup command, reached `CREATED` in 144 s. The log shows `agent: listening on :8080` twice: the `ready` and `validate` hooks booted it.    |
| How many managed base images exist?                              | One, `al2023-1`. It is passed as `base-image-arn`; the Dockerfile's own `FROM` is free.                                                                                                                                                                                        |
| How long does a build take?                                      | 144 s, 163 s, 164 s and 184 s. The POC's hand-built image took about 190 s.                                                                                                                                                                                                    |
| What is a recipe step, inside the managed build?                 | root, with Internet egress. No route to the deployment's VPC, and its private database name does not resolve. No credentials in the environment or in files. No Docker or BuildKit socket.                                                                                     |
| Can a recipe step obtain credentials?                            | Yes. IMDSv2 answers, and hands out the **build role's** credentials (`assumed-role/<build role>/Lambda-microvmsExecutor-…`).                                                                                                                                                   |
| What can it do with them?                                        | Exactly the build role's policy. With the POC's policy: `PutObject` and `GetObject` anywhere in the artifacts bucket. Denied: the capture bucket, IAM, EC2, Secrets Manager, listing MicroVM images. Without `ListBucket` a missing key reads as 403, which is not protection. |
| Does the managed builder need write access, or the whole bucket? | No. A role with `GetObject` on one prefix and the two log actions, and no ECR statement, built and booted the image. From inside that build: every write denied, its own context readable, an existing object under another prefix denied.                                     |

So the managed builder already satisfies rule 2 for the control plane. What it leaves open is
**tampering between tenants**: with the POC's policy, one tenant's recipe can overwrite what another
tenant's image is built from.

## 3. Decisions

### D1. An adapter names the builder of the image it boots

A runtime is registered with the worker as a pair:

```ts
interface RegisteredRuntime {
  readonly adapter: RuntimeAdapter;
  /** Builds, from a blueprint, the image this adapter boots. Never absent. */
  readonly imageBuilder: WorkspaceImageBuilder;
}
```

The build job takes `runtimes`, not adapters and a worker-wide builder. It selects the adapter first
(selection is pure), then plans, reuses by plan hash, builds and publishes with **that runtime's**
builder, then launches. A blueprint no adapter supports is still reported by the launch, and builds
with the default runtime's builder as before.

The pair is registered, instead of the builder being a member of `RuntimeAdapter`, because an
adapter is constructed in about ninety places, most of them tests that never build an image. The
guarantee is the same: nothing can take workspaces without a builder, and D2 covers every id.

There is no "unused" escape. A runtime that cannot build its image cannot be registered.

### D2. A conformance test every adapter must pass

`runtime-adapter.conformance.test.ts` holds each adapter id to two facts, for one blueprint that
requires an OS family and selects a catalog package: the recipe planned for the build starts from
that family and installs the package, and the launch boots the image that build published and no
other. Its cases are keyed by `RuntimeAdapterId`, so adding an id without a case does not compile.
An adapter that does not conform yet is listed by name under `it.fails`, which fails once the
adapter conforms, so the entry is removed with the fix. MicroVM is the one entry today.

This pins the contract at the recipe, not inside a live machine. Live proof stays with each
runtime's e2e (`docker.e2e.ts`, the kind e2e, the MicroVM e2e), which gains the same blueprint.

### D3. A builder says where the recipe runs

```ts
interface WorkspaceImageBuilder {
  /**
   * `host`: recipe steps share the control plane's kernel, Docker daemon or credentials.
   * `isolated`: they run somewhere that cannot reach the control plane or its credentials.
   */
  readonly isolation: "host" | "isolated";
  readonly plan: ...;
  readonly buildAndPublish: ...;
}
```

Host Docker is `host`. The Kubernetes rootless BuildKit Job and the MicroVM managed build are
`isolated`. The API reports the selected default adapter's builder isolation on its health and
capability surface so a control plane on top can refuse a posture. Sealant does not refuse `host`
itself: a single-user self-host is a supported shape.

### D4. The MicroVM builder

`MicrovmWorkspaceImageBuilder` implements the interface with the Lambda MicroVM image API:

- **Plan.** The existing planner: blueprint → OS family → Containerfile → plan hash. The MicroVM
  recipe is that Containerfile with the agent layer in place of its entrypoint: `sealantctl`, the
  agent files, the agent port, and guest-local Docker when the blueprint asks for it. The planned
  Containerfile already carries `sealantd` and the boot `ENV`. The hash covers the recipe's text, so
  the daemon pin is in it, plus the image settings (memory, port, Docker) and a digest of the files
  the recipe copies in. A daemon upgrade or a changed agent builds new images.
- **Build.** Zip the context, upload it to an unguessable per-build key, `CreateMicrovmImage` named
  by the plan hash, poll to `CREATED`. A failed build fails the job with the state reason.
- **Publish.** `PublishedImage` records the image ARN and version. Reuse by plan hash then finds a
  built image by name, exactly as it does a registry tag, and `GetMicrovmImage` is the liveness
  check in place of a registry `HEAD`.
- **Launch.** The adapter boots the published image, pinned to the version the build made, and
  refuses a launch whose published image is not a MicroVM image. `SEALANT_MICROVM_IMAGE_ARN` and the
  three settings beside it are retired: the API and the worker refuse to start while one is set. The
  Docker-capable variant is an image setting the builder applies when the blueprint asks for the
  Docker service and the operator allows it (`SEALANT_MICROVM_DOCKER_ENABLED`, off by default, since
  that image is created with the `ALL` OS capability).
- **Base images.** Distro bases come from public ECR mirrors (`public.ecr.aws/docker/library/…`), so
  the build role needs no registry permission.
- **Trusted material.** The agent files are copied into the worker's own image when Sealant is
  released and read from there, never from the artifacts bucket. The worker checks they are present
  when it starts. `sealantd` and `sealantctl` are not in the build context at all: the recipe takes
  both with `COPY --from` the released sealantd image, which the managed build pulls (measured
  2026-09-20). So a build context is a Containerfile and two or three small scripts, and building a
  MicroVM image needs no Docker on the control plane. The agent's suspend and terminate hooks run
  `sealantctl capture flush`, so the recipe needs a sealantd release whose image ships the client
  (sealantd#94).
- **One recipe, one image.** Two workspaces with the same plan produce one build. On 2026-08-30 to
  2026-09-12 a host worker whose reuse lookup never matched built an image per workspace and left
  513 build directories, 400 GB (fixed for the host builder in #229). Here the same fault would pile
  up images in an AWS account, where nothing fills up to warn anyone. A test asserts the second
  workspace builds nothing.
- **Retention and a cap.** The builder ships with both. The worker's one retention sweep decides
  what to keep from the build-job history, whatever the runtime: a live workspace's image, the
  newest image of the last N plans, anything inside the age floor. It deletes a MicroVM image with
  `DeleteMicrovmImage` and everything else through the registry. It also sweeps this control plane's
  MicroVM images that no build job names, which a build that died after `CreateMicrovmImage` or a
  database started fresh leaves behind. Past a configured number of images the builder refuses to
  create another and says why. The per-build zip is deleted once the image is `CREATED` or failed.
- **Proven live, 2026-09-20** (`src/images/microvm/built-image.e2e.ts`, opt-in). A Fedora blueprint
  with a catalog package built in 203 s. The same plan again took under a second and built and
  uploaded nothing. The adapter booted that image in 7 s, and inside the VM were the blueprint's OS,
  its package, `sealantd`, a `sealantctl` that reaches the daemon, and the cloned repository. A
  fenced stop took 3 s, and the console shows the terminate hook's `sealantctl capture flush`
  answered by the daemon. The run found two faults no fake could:
  - `GetMicrovmImage` and `DeleteMicrovmImage` take an image ARN and refuse a bare name ("Invalid
    ARN format"). The live API completes a name with the build role's partition and account.
  - The create request's `clientToken` was the plan hash. A plan is built again once its image is
    deleted, and the second create, replaying a token the platform had already completed, sat in
    `CREATING` for the whole thirty-minute timeout with no build running. An image in that state
    cannot be deleted either. The token is now one per attempt; the name already makes one plan one
    image. With that, delete then rebuild of the same name took 203 s.
- **Every managed family, with Docker, proven live on 2026-09-20** (the same spec, one run per
  family with `SEALANT_MICROVM_BUILT_IMAGE_E2E_DOCKER=1`). Build, boot, and inside the VM the OS,
  the package, `sealantd`, a `sealantctl` that reaches the daemon, all three harnesses,
  `docker info`, and one container run:

  | Family | Build | Boot | Base                                       |
  | ------ | ----- | ---- | ------------------------------------------ |
  | fedora | 223 s | 7 s  | `fedora:41` from the public ECR mirror     |
  | ubuntu | 264 s | 8 s  | `ubuntu:24.04` from the public ECR mirror  |
  | nix    | 244 s | 8 s  | `nixos/nix:latest`                         |
  | arch   | 385 s | 8 s  | Arch Linux ARM's signed rootfs (see below) |

  Three faults found on the way, none of them in Docker itself:
  - **Arch has no ARM64 container image.** Docker Hub's `archlinux` is x86_64 only, and a MicroVM is
    ARM64, so no Arch workspace could be built there at all. The official ARM port, Arch Linux ARM,
    ships a rootfs tarball signed by its build system key. The recipe's first stage fetches the
    tarball and its signature over the port's mirrors, verifies the signature against the key
    shipped in the build context (`microvm-image/archlinuxarm-builder.asc`, fingerprint pinned in
    the recipe), unpacks it, and the image starts from that filesystem.
  - **No native harness binary started on the nix image.** It has no `/lib64/ld-linux-*`: every
    binary in it names a loader inside the store. `codex`, `claude` and `opencode` install and then
    fail to execute. The nix package layer now links glibc's loader into `/lib` and `/lib64`. This
    is the family's recipe, so it fixes the Docker and Kubernetes runtimes too.
  - **opencode's postinstall was skipped by a recent npm** (Arch ships one), so its native binary
    was never fetched. Its install now carries `--allow-scripts=opencode-ai`, as claude-code's
    already did. Every family's recipe.

- **Names, not tags.** `ListMicrovmImages` returns no tags, so a listing can only tell whose an
  image is by its name: `<prefix>-<24 hex of the plan hash>`, prefix `sealant-ws`
  (`SEALANT_MICROVM_IMAGE_NAME_PREFIX`). The cap counts those names and the sweep deletes only
  those. Two control planes that share an AWS account take different prefixes; with the same one
  each would count, and after the age floor delete, the other's images.
- **First launch.** Two to three minutes, once per distinct plan. The job stays `running`; Mend
  already tells the user a first launch builds the image.

### D5. One build role and one prefix per tenant

The builder takes the build role and the artifacts location **per build**, from the launching
principal's organization:

- artifacts at `s3://<bucket>/<organization>/<random>.zip`;
- a build role whose policy is `s3:GetObject` on that organization's prefix and the two log actions.
  No `PutObject`, no `ListBucket`, no ECR.

A recipe step can then read its own organization's build contexts, which hold recipes and never
secrets, and nothing else. Sealant does not create IAM roles: the deployment supplies a role and a
prefix per organization (or a template it expands), and the builder refuses a build whose role and
prefix do not match the principal.

The image-level settings a tenant must not choose (`additional-os-capabilities`, memory, hooks) come
from the deployment, never from the blueprint.

### D6. Mend refuses `multi` while recipes run on the host

Mend's multi mode gate (mend `docs/adr/0003`) gains an item: the default runtime's image builder is
`isolated`, read from Sealant's capability surface. `MEND_TENANCY=multi` does not start on a control
plane whose image builds run on its own host.

## 4. Delivery

1. D1 and D3, with the Docker and Kubernetes adapters carrying today's builders. No behaviour
   change. D2's conformance test, which MicroVM fails.
2. D4 with a single deployment-wide role and prefix. MicroVM passes conformance. `build-image.sh`
   and its two hand-written Dockerfiles are removed: there is no image to pre-build, and the script
   could not run against a released daemon.
3. D5. The AWS OpenTofu in mend gains per-organization roles and prefixes.
4. D6 in mend, then its single-instance deployment (mend#312) drops the "sessions will not start"
   caveat. That deployment never mounts the Docker socket: the socket is root on the host, and "for
   staging only" would be a promise about the worker's code, not a control.

## 5. Out of scope

- Account quotas on MicroVM images were not measured. The cap in D4 is set below whatever they turn
  out to be.
- Build caching across plans. Each plan is a full build.
- A Cloudflare builder beyond what that adapter does today; it is covered by conformance like the
  rest.
