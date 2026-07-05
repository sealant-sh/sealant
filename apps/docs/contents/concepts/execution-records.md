---
title: Execution records
description:
  A run is one harness execution; the execution record is its durable, append-only, replayable
  history — evidence, not verdicts.
---

When a [harness](/docs/concepts/harnesses) does work inside a [sandbox](/docs/concepts/sandboxes),
two things exist:

- A **run** — a single harness execution inside a sandbox. It is the unit of work you start.
- An **execution record** — the durable, append-only history of that run. It is what you keep and
  what you review after the run is over.

The run is the event; the record is the evidence.

## The record is append-only

As a run executes, everything that happens inside the sandbox is captured as one ordered stream of
events and stored as an **append-only log**. Nothing is edited after the fact. Every view you look
at — the terminal, the timeline, the list of changes — is _derived_ from that log, never a separate
recording. Adding a new way to look at a run is a re-read of the same log, not a re-capture.

Because the log is the source of truth, the record is faithful: it reflects what the harness
actually did, in order, byte for byte.

## Four ways to read a run

The record exposes a run through a few derived views. Each answers a different question.

- **Timeline** — _what happened, in order._ One entry per event: commands run, files changed,
  process exits, durations. This is the spine of a review.
- **Scrollback** — _what the terminal actually showed._ Byte-exact reassembly of the run's output,
  reconstructed in true order. Where output was coalesced or dropped, you see an explicit gap, never
  a silently corrupted stream.
- **Changes** — _what the run did to the tree._ The file additions, edits, and deletions the run
  produced.
- **Loss** — _what we know we missed._ Every known gap — dropped events, sequence gaps, a watch
  overflow, an early close — is recorded as a first-class fact. Completeness is auditable rather
  than assumed.

That last view is the point of the whole design: Sealant would rather tell you it lost a span than
pretend the record is complete.

## Replay

Because the full ordered log is retained, a run can be **replayed** — walked through from the start
to reconstruct what the terminal showed at any point. Replay is a pure re-read of the stored log, so
it is repeatable and consistent every time you run it.

## Evidence, not verdicts

An execution record never tells you whether a run "passed" or "succeeded." It shows you what
happened — the commands, the output, the changes, the losses — and leaves the judgment to you. There
is no score, no pass/fail flag, no opinion baked into the record. You read the evidence and you
decide what it means.

## How you read records today

> Runs and their timeline, scrollback, changes, and loss views are exposed three ways: the web app's
> **run record page** (`/sandboxes/<sandbox-id>/runs/<run-id>` — the folded command timeline with
> per-command scrollback, changes, network, and raw events), the
> [HTTP API](/docs/reference/http-api) (`GET /v1/runs/:runId/timeline`, `/scrollback`, `/changes`,
> `/loss`), and the [preview SDK](/docs/reference/sdk) (`run.record.replay()`, `timeline`, `stream`,
> `scrollback`, `loss`, `summary`, `transcript`). Artifact retrieval and browser-evidence views are
> not shipped yet.

## Related

- [Sandboxes](/docs/concepts/sandboxes) — where runs happen.
- [Harnesses](/docs/concepts/harnesses) — what produces a run.
- [Runs & execution records](/docs/guides/runs-and-execution-records) — starting a run and reading
  its record.
- [HTTP API](/docs/reference/http-api) and [SDK](/docs/reference/sdk) — the programmable surface.
