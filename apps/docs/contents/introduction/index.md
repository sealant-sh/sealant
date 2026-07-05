---
title: What is Sealant
description:
  An open-source, self-hosted runtime that gives coding harnesses a real place to work and turns
  every run into a replayable execution record.
---

Sealant is an open-source, self-hosted **runtime for agentic development**. The agent ecosystem is
full of harnesses that decide _what_ to do — planners, model loops, coding agents. Sealant is the
layer underneath: somewhere real for that work to happen, and a trustworthy record of what actually
happened.

You bring your own harness. Sealant supplies the environment and the evidence.

## The three nouns

Three nouns carry the whole system:

- **Sandbox** — a live, disposable development environment built around a real repository: the code,
  the dependencies, the harness, the processes, the services the work needs. You create it, the
  harness works in it, you can step into it over SSH, and when you're done it goes away. Where the
  work happens.
- **Run** — a single harness execution inside a sandbox. The sandbox is ephemeral; the run is what
  you keep.
- **Execution record** — the durable, append-only, replayable history of a run: one ordered,
  correlated stream of process lifecycle, byte-exact terminal I/O, file changes, network activity,
  and artifacts. Not a pile of logs — structured data you can query, render, and replay long after
  the sandbox is gone. (The views shipped today are the timeline, terminal scrollback, file changes,
  and loss accounting — see [What ships today](/docs/introduction/what-ships-today).)

The core loop is the same everywhere: **create a sandbox → run a harness → replay the record →
review the change.**

See [Sandboxes](/docs/concepts/sandboxes), [Execution records](/docs/concepts/execution-records),
and [Harnesses](/docs/concepts/harnesses) for the full concept pages.

## What Sealant is not

Honest boundaries are a feature:

- **Not an agent or a model.** Sealant is the environment and execution layer _around_ a harness.
  Bring your own — OpenCode, Claude Code, Codex, a custom loop, a CI worker.
- **Not just a container runtime.** Containers isolate; Sealant adds the developer-work model on top
  — harness execution, human SSH access, process supervision, file diffs, and the record.
- **Not a hosted service.** Self-hosted only. Your code and your runs stay in your infrastructure.
- **Not a judge.** It reports evidence, never verdicts. No confidence scores, no "safe to merge."
  You decide what the evidence means.

## Who it's for

- **Teams building AI coding products** who need an execution runtime they fully control and can run
  on their own infrastructure, instead of renting a black-box sandbox SaaS and shipping their users'
  code to a third party.
- **Solo and open-source developers** experimenting with agent harnesses who want a real, recorded
  sandbox without writing container glue for every project.

Both share the same need: a runtime they own, that records what happens, with no lock-in.

## Where the project stands

Sealant is early and says so. The most complete path today is the self-hosted install and the
sandbox flow: install with one command, create a sandbox around a real repository through the web
app, and SSH into it. The HTTP API for runs and execution records is shipped; the TypeScript SDK is
a preview; a CLI, API tokens, and several web UI areas are still planned or preview. The full,
honest status table is at [What ships today](/docs/introduction/what-ships-today).

## Next steps

- [How Sealant works](/docs/introduction/how-sealant-works) — the mental model of a self-hosted
  install.
- [Install Sealant](/docs/getting-started/install) — one command, needs only Docker with Compose v2.
- [Your first sandbox](/docs/getting-started/first-sandbox) — from sign-up to SSH.
