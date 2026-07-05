---
title: Runs and execution records
description:
  What the web app shows about a run today, and how to inspect an execution record through the API
  and preview SDK while the review UI matures.
---

A **run** is a single harness execution inside a sandbox. Its durable, replayable history — process
lifecycle, byte-exact I/O, file changes, network activity, artifacts — is the **execution record**.
For the data model behind the record, see [Execution records](/docs/concepts/execution-records).

This page is about working with runs and records as they exist today. Be aware up front: the record
views shipped today are the timeline, byte-exact terminal scrollback, file changes, and explicit
loss accounting — artifact retrieval and the polished in-app review surface are not shipped yet.
Deep inspection currently happens through the API and the preview SDK, not a finished web UI.

## What the web app shows today

The sandbox detail page (`/sandboxes/<sandbox-id>`) is the current review surface. It is
summary-oriented — it shows the shape of what happened, not a full telemetry replay:

- **Attempts** — the build/run attempts for the sandbox.
- **Recent events** — sandbox lifecycle events.
- **Runtime info** — the runtime adapter, status, resource, and endpoint.
- **Published image** — the output image reference and digest.
- **Spec** — the sandbox spec summary, with the raw manifest at `/sandboxes/<sandbox-id>/spec`.

What is **not** in the web app yet: there is no dedicated run route, no timeline replay, no terminal
scrollback viewer, no diff/changes review, no artifact browser, and no browser-evidence surface.
Some routes advertise more than they deliver — `/sandboxes/<sandbox-id>/trace`, `/diff`, and
`/validation` currently redirect to the spec view, and the run rows under
`/repositories/<id>/sandboxes` are static mock data. Do not treat those as a working review surface.

For real record inspection today, use the API or SDK below.

## The run and record API

The control-plane API exposes runs and their records directly. Base URL is normally
`http://127.0.0.1:4000` (or your `SEALANT_API_PORT`). See [HTTP API](/docs/reference/http-api) for
full request/response shapes.

| Operation                          | Endpoint                         |
| ---------------------------------- | -------------------------------- |
| Create a run                       | `POST /v1/runs`                  |
| List runs                          | `GET /v1/runs`                   |
| Get a run                          | `GET /v1/runs/:runId`            |
| Update a run                       | `PATCH /v1/runs/:runId`          |
| Timeline (ordered "what happened") | `GET /v1/runs/:runId/timeline`   |
| Terminal scrollback                | `GET /v1/runs/:runId/scrollback` |
| Loss accounting (known gaps)       | `GET /v1/runs/:runId/loss`       |
| File changes                       | `GET /v1/runs/:runId/changes`    |

The `timeline`, `scrollback`, `loss`, and `changes` endpoints are the record: the ordered event
stream, byte-exact terminal reassembly, first-class accounting of any dropped or missing events, and
the file diff. They are derived from the same append-only log described in
[Execution records](/docs/concepts/execution-records).

Note on identity: there are **no API tokens or bearer-auth enforcement today**. The current model
passes an owner id (`ownerUserId` / `userId`) in the payload or query. This is temporary scaffolding
and will change when auth lands. See [HTTP API](/docs/reference/http-api).

## The preview SDK

The `@sealant/sdk` package wraps these endpoints with a fluent API. It is **preview**: the package
is unpublished (`"private": true`), so today it is only consumable inside the monorepo, and its
README is stale — trust the source under `packages/sdk/src`. See [SDK](/docs/reference/sdk).

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://127.0.0.1:4000" });

const sandbox = await sealant.sandboxes.create({ repository, harness: opencode() });
const run = await sandbox.harness.run(prompt);

await run.record.replay();
```

The sandbox → run → record path is implemented: `sandboxes.create/get/list`,
`sandbox.status/ready/events` (polling), `harness.run` (server-side `POST /v1/runs`), `runs.get`,
and on the record `replay`, `timeline`, `stream` (polling, not push), `scrollback`, `loss`,
`summary`, and `transcript`. Other typed methods — `harness.start`/`session`,
`sandbox.stop`/`restart`/`expire`, artifact retrieval, and the time-travel folds (`fileTreeAt`,
`processTreeAt`) — exist on the surface but are not fully wired yet.

## Related

- [Execution records](/docs/concepts/execution-records) — the data model and why it is lossless and
  replayable.
- [HTTP API](/docs/reference/http-api) — the full run and record endpoints.
- [SDK](/docs/reference/sdk) — the preview client and its current surface.
