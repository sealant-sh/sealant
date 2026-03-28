# Apps

Deployable applications and services live here.

The current app architecture is:

- `web`: main product web app for creating and managing workspaces
- `api`: control-plane API surface for validation, orchestration, lifecycle, and state
- `worker`: background worker for queued workspace image build jobs
- `ssh-gateway`: SSH routing gateway for sandbox access
- `docs`: documentation site for users, contributors, and developers
- `marketing`: public-facing website and launch surfaces
- `electron`: desktop application surface if desktop becomes a first-class client
