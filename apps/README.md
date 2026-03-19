# Apps

Deployable applications, services, and runnable demo entrypoints live here.

The current app architecture is:

- `web`: main product web app for creating and managing workspaces
- `api`: control-plane API surface for validation, orchestration, lifecycle, and state
- `worker`: background worker for queued workspace image build jobs
- `docs`: documentation site for users, contributors, and developers
- `marketing`: public-facing website and launch surfaces
- `electron`: desktop application surface if desktop becomes a first-class client
- `workspace-composition-demo`: runnable demo for exercising composition flows and blueprint examples
