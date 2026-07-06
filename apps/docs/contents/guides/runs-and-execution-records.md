---
title: Runs and execution records
description:
  Reviewing a run in the web app's run record page, and inspecting an execution record through the
  API and SDK.
---

A **run** is a recorded session of work inside a workspace — a one-shot harness execution, or an
interactive session when a person [SSHes in](/docs/guides/ssh-access) (each SSH connection becomes a
run). Its durable, replayable history — process lifecycle, byte-exact I/O, file changes, network
activity, artifacts — is the **execution record**. For the data model behind the record, see
[Execution records](/docs/concepts/execution-records).

One caveat the model is honest about: concurrent runs in the same workspace share one working tree,
so a run's end-of-session file diff is only crisp when runs do not overlap.

This page is about working with runs and records as they exist today. The record views shipped today
are the timeline, byte-exact terminal scrollback, file changes, and explicit loss accounting —
readable in the web app's run record page, through the API, and through the SDK. Artifact retrieval
and a browser-evidence surface are not shipped yet.

## What the web app shows today

The **run record page** (`/workspaces/<workspace-id>/runs/<run-id>`) is the review surface for a
run: the prompt and status up top, an activity strip for orientation, the folded record of commands
on the left (each expanding to its byte-exact scrollback, loaded lazily), and the outcome — file
changes, network activity, raw events — beside it. `?seq=` deep-links an exact moment, a failed run
lands on its failing command, and live runs poll while in progress.

The workspace detail page (`/workspaces/<workspace-id>`) is the summary surface around it: build
history, recent lifecycle events, runtime info, the published image, and the spec (raw manifest at
`/workspaces/<workspace-id>/spec`). `/workspaces/<workspace-id>/trace`, `/diff`, and `/validation`
are reserved URLs that redirect to the latest run record (or the spec when the workspace has no
runs).

Two honest caveats: there is no artifact browser or browser-evidence surface yet, and the run rows
under `/repositories/<id>/workspaces` are still static mock data.

## The run and record API

The control-plane API exposes runs and their records directly. Base URL is normally
`http://127.0.0.1:4000` (or your `SEALANT_API_PORT`). See [HTTP API](/docs/reference/http-api) for
full request/response shapes.

| Operation                          | Endpoint                               |
| ---------------------------------- | -------------------------------------- |
| Create a run                       | `POST /v1/runs`                        |
| List runs                          | `GET /v1/runs`                         |
| Get a run                          | `GET /v1/runs/:runId`                  |
| Update a run                       | `PATCH /v1/runs/:runId`                |
| Timeline (ordered "what happened") | `GET /v1/runs/:runId/timeline`         |
| Raw event by sequence              | `GET /v1/runs/:runId/events/:sequence` |
| Terminal scrollback                | `GET /v1/runs/:runId/scrollback`       |
| Loss accounting (known gaps)       | `GET /v1/runs/:runId/loss`             |
| File changes                       | `GET /v1/runs/:runId/changes`          |

The `timeline`, `scrollback`, `loss`, and `changes` endpoints are the record: the ordered event
stream, byte-exact terminal reassembly, first-class accounting of any dropped or missing events, and
the file diff. They are derived from the same append-only log described in
[Execution records](/docs/concepts/execution-records).

Note on identity: there are **no API tokens or bearer-auth enforcement today**. The current model
passes an owner id (`ownerUserId` / `userId`) in the payload or query. This is temporary scaffolding
and will change when auth lands. See [HTTP API](/docs/reference/http-api).

## The SDK

The `@sealant/sdk` package is published on npm and wraps the main workspace → run → record path with
a fluent API. See [SDK](/docs/reference/sdk).

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://127.0.0.1:4000" });

const workspace = await sealant.workspaces.create({ repository, harness: opencode() });
const run = await workspace.harness.run(prompt);

await run.record.replay();
```

The workspace → run → record path is implemented: `workspaces.create/get/list`,
`workspace.status/ready/events` (polling), `harness.run` (server-side `POST /v1/runs`, blocks until
terminal), `harness.start` (same run, returns the live handle immediately — stream with
`record.stream()`, settle with `run.wait()`), `runs.get`, and on the record `replay`, `timeline`,
`stream` (polling, not push), `scrollback`, `loss`, `summary`, and `transcript`. Other typed methods
— `harness.session`, `workspace.stop`/`restart`/`expire`, artifact retrieval, and the time-travel
folds (`fileTreeAt`, `processTreeAt`) — exist on the surface but are not fully wired yet.

## Related

- [Execution records](/docs/concepts/execution-records) — the data model and why it is lossless and
  replayable.
- [HTTP API](/docs/reference/http-api) — the full run and record endpoints.
- [SDK](/docs/reference/sdk) — the preview client and its current surface.
