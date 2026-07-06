---
title: How Sealant works
description:
  The services a self-hosted Sealant install runs, and how a workspace request flows through them.
---

A Sealant install is a small set of cooperating services, all started by Docker Compose from
`~/.sealant`. This page is the one-page mental model; for exact ports, volumes, and file locations
see [Ports and data](/docs/reference/ports-and-data).

## The services

| Service           | What it does                                                                                                                           | Default address                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Web app           | The product UI: sign-up, workspace creation, workspace detail, SSH key management.                                                     | `http://localhost:3000`          |
| Control-plane API | The HTTP API everything talks to: workspaces, runs, SSH keys, GitHub installations. Serves `/openapi.json` and docs at `/docs`.        | `http://localhost:4000`          |
| Worker            | Background service that picks up workspace build jobs, builds the workspace image, publishes it, and launches the workspace container. | internal                         |
| SSH gateway       | Public-key SSH entry point that routes `ssh ws-<workspace-id>@…` sessions into the right live workspace.                               | `localhost:2222`                 |
| Zot registry      | An OCI image registry that stores built workspace images.                                                                              | `127.0.0.1:5000` (loopback only) |
| Postgres          | Control-plane state: users, workspaces, runs, SSH keys, events.                                                                        | internal only                    |
| RabbitMQ          | Message transport between the API and the worker.                                                                                      | internal only                    |

The installer writes two files — `~/.sealant/compose.yaml` and `~/.sealant/.env` — and everything
else lives in Docker named volumes. By default every published port binds to `127.0.0.1`; nothing is
exposed to your network unless you change `SEALANT_BIND_HOST`
([Beyond localhost](/docs/guides/beyond-localhost)).

One important detail: the worker mounts the host Docker socket. Workspace containers and images are
created on **your host Docker daemon**, as siblings of the compose stack — not nested inside it.

## How a workspace request flows

1. **You submit a spec.** In the web app (or via the [HTTP API](/docs/reference/http-api)) you
   describe the workspace: the repository (raw Git URL or a GitHub App repository), a ref, the
   harness, the target OS and packages, setup commands, and whether SSH is enabled.
2. **The API normalizes and persists it.** The control-plane API validates the spec, stores the
   workspace in Postgres, and enqueues a build job on RabbitMQ.
3. **The worker builds.** The worker leases the job, clones the repository (minting a short-lived
   GitHub App installation token if the repo is private — see
   [GitHub App](/docs/guides/github-app)), resolves packages, and builds an OCI image for the
   workspace.
4. **The image is published.** The built image is pushed to the bundled zot registry, so the
   workspace is reproducible from a pinned image reference and digest.
5. **The workspace launches.** The worker starts the workspace container on the host Docker daemon
   and reports runtime status, endpoints, and lifecycle events back through the API. The web app's
   workspace detail page shows attempts, events, runtime state, and the published image.
6. **You connect.** With SSH enabled and a key registered, `ssh -p 2222 ws-<workspace-id>@localhost`
   reaches the SSH gateway. The gateway verifies your public key against the API (key fingerprint →
   owning user), checks that you own the workspace, and proxies your session into the running
   container. VS Code and Cursor Remote-SSH ride the same path
   ([SSH access](/docs/guides/ssh-access)).
7. **Harness executions become runs.** A run started inside a workspace produces an execution record
   — an ordered, append-only event log you can query and replay through the API's
   timeline/scrollback/changes endpoints
   ([Runs and execution records](/docs/guides/runs-and-execution-records)).

## Trust boundaries, briefly

- Web, API, and SSH gateway are the only host-reachable surfaces, all loopback-bound by default.
- The API and SSH gateway share a generated secret (`WORKSPACE_SSH_GATEWAY_TOKEN`) for the internal
  key-resolution endpoints.
- The current API has no token auth; identity is passed as an owner-user id in requests. This is
  temporary and one of the reasons the API should stay on loopback for now — details in
  [Security model](/docs/concepts/security-model) and
  [What ships today](/docs/introduction/what-ships-today).

## Next steps

- [Install Sealant](/docs/getting-started/install)
- [Your first workspace](/docs/getting-started/first-workspace)
- [Installer and compose reference](/docs/reference/installer-and-compose)
