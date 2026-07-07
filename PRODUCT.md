# Sealant — Product Definition

> **Status:** Working draft, started 2026-07-07. This supersedes `SEALANT-PLAN.md` (stale — predates
> the sandbox→workspace rename). This file is the "what we will build and why." The sequenced
> engineering plan lives in a separate roadmap file.

## What Sealant is

Sealant is an **open-source, self-hosted runtime and SDK for running and recording AI-agent (and
human) work in isolated workspaces.** You point it at a repo, hand a harness a task, and it gives
you back a durable, replayable record of everything that happened.

It is not a SaaS and there is no managed cloud. Success is adoption, developer mindshare, and the
platform being good enough that people build products on it. The first flagship product built on the
SDK is **Handoff** (task → verified change → PR); it lives in its own repo and is out of scope here.

## The primitives

Three nouns are the product. Two more make a launch reusable and cumulative.

- **Workspace** — the live, isolated environment (Docker today). Ephemeral, built fresh from a base
  image + repo.
- **Run** — the durable execution record. A run captures a harness (or human) doing work in a
  workspace: commands, output, diffs, attribution, timeline. **The run is the payoff.**
- **Harness** — the agent that does the work (Claude Code, Codex, opencode, or a custom command),
  invoked inside the workspace and drained into the run.
- **Profile** — a reusable, versioned _environment_ template: repo + harness + env + secrets +
  connected-account credentials + setup. "How to build the workspace." Launch from a profile instead
  of filling in a form every time.
- **Context** — reusable _agent knowledge_ fed to the harness at launch, drawn from a curated
  **context library** that is fed by past runs and by hand-authored docs. "What the agent already
  knows." (See below — this is the new core capability.)

## The thesis: runs that compound

Today every agent run starts cold. The harness gets a repo and a prompt; everything it figured out
last time — the architecture, the gotchas, the conventions, the "don't touch X" — evaporates when
the run ends. And there is no reliable way to hand-author reusable knowledge ("here's how our auth
works") and feed it to every run.

Sealant already records every run. The move is to close the loop:

```
   launch ──▶ workspace ──▶ harness run ──▶ record
     ▲                                        │
     │                                        ▼
  inject context ◀── context library ◀── capture context
```

**Runs produce context; context improves runs.** The record stops being a passive audit artifact and
becomes the raw material for a compounding knowledge base. That flywheel — not the sandbox, not the
SDK ergonomics — is the reason to build on Sealant instead of shelling out to Docker yourself.

## What we will build

Three workstreams. The first two are the product story; the third is table-stakes that unblocks real
self-hosting.

### 1. Context library (new core capability)

A store of reusable, versioned **context items** — units of agent knowledge. Each item has a body
(markdown/text) and a kind: hand-authored **instruction/doc**, or a **learning captured from a
run**.

- **Author** — write a context item directly (conventions, architecture notes, API guides, "how our
  auth works"). Versioned, so editing it doesn't break a run that used an earlier version.
- **Capture** — at the end of a run, extract reusable context _from_ it and save it as a new item or
  a new revision of an existing one. Harness-assisted (ask the agent to write "what I learned")
  and/or curated by a human from the record. Captured items carry provenance back to the run they
  came from.
- **Inject / attach** — select context items (directly, or via a profile) when launching. They are
  materialized into the workspace where the harness reads them, so the agent boots _warm_, and the
  set of injected items is recorded as **run provenance** so a replay is fully reproducible.
- **Library** — browse, search, and organize items; group them into named **context sets** that a
  profile can reference (e.g. "backend-conventions" always injects these four items).

Injection mechanics (native memory files vs. a known context dir vs. prompt-prepend, and how
provenance is stamped into the record) are a design decision for the engineering plan. Behaviorally:
the harness sees the context, and the record shows exactly what context produced the run.

The data model mirrors the existing profiles pattern (owner-scoped, versioned revisions,
fingerprint, active-revision pointer, snapshot-on-launch for reproducibility).

### 2. Profiles, finished

The DB model for profiles is rich and already there; only the credential-binding slice is wired end
to end. Finish it so a profile is a real, usable launch primitive:

- **CRUD** — create, edit, archive profiles and their revisions (there is no create/update API
  today; the create form is a dead stub).
- **Config surfaces** — real UI + API for the config a profile carries: repo + harness, env vars,
  secret bindings, SSH settings, connected-account credentials, and its **context set**.
- **Wire launch** — resolve a profile's active revision at launch, apply its config, inject its
  env/secrets/context, and snapshot the resolved config into the run for reproducibility. Today the
  `profileRevisionId` columns exist on workspaces/attempts but nothing ever populates them.

Result:
`launch = profile (reusable environment + context) + per-run overrides (this task, extra context)`.
Profiles and context are the same idea from two angles — reusable vs. per-run — and share the launch
path.

### 3. Workspace lifecycle (table-stakes)

Workspaces currently only ever `launch()` — there is no stop, TTL, expiry, or garbage collection, so
containers leak forever. This blocks anyone from actually self-hosting Sealant for real work. Add:

- **stop / remove** on the runtime adapter and SDK (`workspace.stop`/`restart`/`expire` reject
  NotImplemented today).
- **TTL / idle reaper** — expire and reap workspaces so a self-host install doesn't accumulate dead
  containers.

## Explicitly out of scope this round

- **Filesystem snapshot / persistence / resume** — starting a workspace from a _prior workspace's
  end state_. Powerful, but a real lift (OCI-commit or volume persistence) and distinct from agent
  context. Later.
- **Downstream products** — Handoff (flagship), Verify, Repro. They consume the published SDK from
  their own repos; the platform work here is what they'll build on.
- **Interactive harness sessions**, browser-as-evidence, k8s/k3s adapters, control-plane auth / API
  tokens. Known future work, not this round.

## Honest status

What actually ships today (shipped / preview / mock / planned per surface) is tracked in
`apps/docs/contents/introduction/what-ships-today.md`, which stays the single source of truth. In
short: the create → run → record → replay loop and the SDK are real; profiles are half-built;
lifecycle and the context library do not exist yet.
