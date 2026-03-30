This repo is in a transitional middle state: there is a real architecture trying to emerge, but the
boundaries are still blurry.

# Take

- I’d call the messiness level medium-high: roughly a 6.5/10; not “burn it down,” but definitely
  “stop adding features without tightening seams.”
- The good news is the direction is visible: apps/api + apps/worker + shared packages already form
  the beginnings of a proper control plane.
- The bad news is the product surface is split between real flows, mock flows, and cross-app
  imports, so the system feels more assembled than composed.

# What’s Going On

- apps/web is not just a frontend; it is a mini backend too, with local auth routes in
  apps/web/src/routes/api/auth/\$.ts, a local tRPC BFF in apps/web/src/routes/api/trpc/\$.ts, and
  server-side resource wiring in apps/web/src/lib/trpc/context.ts.
- The real sandbox flow is: web UI -> web tRPC router in apps/web/src/lib/trpc/router.ts -> HTTP
  client in apps/web/src/lib/api/core-api-client.ts -> Hono API in apps/api/src/app.ts -> RabbitMQ
  -> worker in apps/worker/src/process-sandbox-build-job.ts.
- apps/api is the real orchestration center, but its handlers are still doing too much directly
  against repositories and integrations.
- apps/worker is already the cleanest candidate for a real workflow runtime;
  apps/worker/src/process-sandbox-build-job.ts is basically an imperative program waiting to become
  an Effect pipeline.
- Shared packages are valuable and mostly sensible: packages/db, packages/sandbox-build-queue,
  packages/source-integrations, packages/runtime-adapters-api, packages/sandbox-composition.

# Where It’s Messy

- The web app imports API internals directly from apps/api/src/... in
  apps/web/src/lib/api/core-api-client.ts and apps/web/src/lib/trpc/router.ts; that couples the UI
  to API file layout instead of a shared contract package.
- The registry UI is still fake: apps/web/src/lib/api/registry-service.ts is explicit mock data,
  while apps/api/src/routes/registries/registries.index.ts already has real endpoints.
- Large parts of the product UI are still static/demo data from
  apps/web/src/lib/navigation/sandbox-data.ts, especially profiles, repositories, and issues.
- There is duplicated orchestration between apps/api/src/routes/sandboxes/sandboxes.handlers.ts and
  apps/api/src/routes/sandbox-build-jobs/sandbox-build-jobs.handlers.ts.
- apps/api/src/routes/sandboxes/sandboxes.handlers.ts is over 1,200 lines; that is a strong signal
  that use-case logic needs extraction.
- The web app owns DB/auth concerns directly through @sealant/db and @sealant/auth, so “frontend,”
  “BFF,” and “control plane” responsibilities are mixed.
- The repo has domain ambition around sandboxes and issue workflows, but only sandboxes are
  materially wired; issue workflow persistence exists in packages/db, but no real app/API surface is
  built around it yet.

# Env Loading

- apps/api/src/env.ts is the most mature env setup: schema merging, dotenv loading from several
  roots, and GitHub private-key file resolution.
- But it also mutates process.env, which works, yet makes config loading more implicit than it
  should be.
- apps/worker/src/env.ts validates env but does not load dotenv files, so local startup behavior is
  less consistent than the API.
- The web app has no central validated env module; it mixes import.meta.env and process.env in
  apps/web/src/lib/api/core-api-client.ts and apps/web/src/lib/trpc/client.ts.
- Several shared packages expose import-time env singletons like packages/db/src/env.ts and
  packages/auth/src/env.ts; that makes testing and composition harder.
- .env documentation is uneven: root .env.example is very incomplete compared with actual runtime
  needs, while apps/web/.env.example is more realistic.

# Structural Risks

- There is no strong transaction boundary around multi-step writes; sandbox creation does several
  repo calls and then compensates manually if queue publish fails.
- Error handling is mostly ad hoc try/catch plus string messages; there is not yet a consistent
  domain error model.
- Logging is mostly console.log/console.error, which is fine early, but thin for a control plane.
- There is dependency skew: apps/api, apps/worker, and many packages use Zod 3, while apps/web and
  packages/auth use Zod 4.

# Why EffectTS Fits

- The worker pipeline in apps/worker/src/process-sandbox-build-job.ts is the best first seam: it is
  a linear, side-effect-heavy program with retries, cleanup, state transitions, and external
  services.
- The API already has proto-DI in apps/api/src/lib/types.ts and apps/api/src/lib/create-app.ts; that
  maps naturally to Effect Layer.
- Env/config is fragmented enough that Effect Config would immediately reduce confusion.
- Typed error channels would clean up the current “throw generic Error, then stringify it at the
  edge” pattern.
- Sandbox lifecycle and future issue workflow lifecycle are both strong fits for Effect.gen style
  orchestration.

# What The Future Looks Like

- Short term: promising, if you stop widening the current boundary blur.
- Medium term: very good, if you extract shared API contracts, unify config loading, and move
  orchestration out of handlers.
- Long term: EffectTS can give this repo a real execution model instead of a pile of async
  functions, especially for workers, lifecycle state machines, retries, and dependency wiring.

# Recommended Order

- 1. Start with the worker in apps/worker/src/process-sandbox-build-job.ts; it gives the biggest
     Effect payoff with the smallest blast radius.
- 2. Extract sandbox/job use-case services out of
     apps/api/src/routes/sandboxes/sandboxes.handlers.ts and
     apps/api/src/routes/sandbox-build-jobs/sandbox-build-jobs.handlers.ts.
- 3. Create a shared contract package so apps/web stops importing apps/api/src/... and stops
     mirroring types by hand.
- 4. Introduce one env/config story per app, then remove import-time env singletons where possible.
- 5. Only after that, bring Effect to the web server boundary in apps/web/src/lib/trpc/context.ts;
     don’t start in React components.
