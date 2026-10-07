---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`ready()` no longer spends its readiness bound on an image build. A first launch on a new image
whose `apt-get install` took eight minutes on a slow mirror used to fail at the 10-minute bound even
though the workspace would have come up.

- A launch reports its phase while the workspace is not ready: `queued`, `image-build` (with the
  build's `step`/`steps`/`stepName` and `progressAt`, when it last wrote output) or `boot`. Read it
  with `workspace.phase()`; on the wire it is `phase` on a workspace read. `events()` (and
  `onEvent`) yields `phase.<name>` each time the launch moves to another phase or its build to
  another step, e.g. `Building the workspace image (step 2/12: RUN apt-get update …)`.
- `ready()` bounds each phase on its own. `readyTimeoutMs` (default 10 minutes) bounds the launch
  outside the image build, queued and booting (`workspace_ready_timeout`); `imageBuildTimeoutMs`
  (default none) bounds the build as a whole (`workspace_image_build_timeout`). Pass them to
  `create()` for the handle or to `ready(options)` for one wait. A build is otherwise waited for as
  long as it reports progress: the worker fails one that writes nothing for
  `WORKSPACE_IMAGE_BUILD_STALL_MS` (10 minutes), and `ready()` rejects with
  `workspace_image_build_stalled` and the step it stopped on. A launch the control plane failed
  rejects with `workspace_not_ready` and the control plane's reason. A control plane that reports no
  phase is bounded by `readyTimeoutMs` as before.
- A Docker worker whose database has no record of a plan reuses the `plan-<hash>` image the Engine
  kept, once it has read the image's probe back, instead of building it again.
  `WORKSPACE_IMAGE_BUILD_CACHE_DIR` keeps BuildKit's layer cache in a directory between builds.
