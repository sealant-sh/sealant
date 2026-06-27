# Landing Page — Content Map

_Where each piece of the homepage goes: section order, the copy that lives in each slot, and the
visual that sits beside it. This is the IA + copy spec, not the visual system (see `DESIGN.md`) and
not the narrative rationale (see `MARKETING-REDESIGN-PLAN.md`)._

## Organizing principle

The page is ordered by **value**, not by implementation:

```text
1. Reviewable agent work
2. Replayable run record
3. SDK / runtime
4. What the record captures
5. Live sandboxes and console
6. SSH / VS Code / Cursor access
```

Three nouns anchor everything:

- **Sandbox** — where the work happens (the platform object).
- **Run** — what you keep.
- **Execution record** — the durable, replayable history.

Editor access (SSH, VS Code, Cursor) is a **path into** the sandbox, not the headline. The sandbox
is the platform object; the run is the retained value. The homepage sells the **run review** and
treats the sandbox console as the runtime underneath it.

## Section map

| # | Section | What goes here |
|---|---|---|
| 1 | **Header** | Logo + developer-native nav + Star CTA |
| 2 | **Hero** | One-line definition + happy-state run-review visual |
| 3 | **Model strip** | Sandbox → Harness → Record → Review |
| 4 | **The run is the product surface** | Run-review detail screenshot + evidence bullets |
| 5 | **Build on the SDK** | Runtime-not-glue copy + SDK code block |
| 6 | **What the record captures** | 6-card grid of captured signals |
| 7 | **Real sandboxes & console** | Sandbox console screenshots + access paths |
| 8 | **One runtime, many shapes of work** | 4 work-type cards |
| 9 | **Open-source & self-hosted** | 3 trust cards |
| 10 | **Final CTA** | Adoption asks |

---

## 1. Header

**Layout**

```text
Sealant                          Docs   SDK   Examples   Runs   GitHub
                                                         [Star on GitHub]
```

**Nav items:** Docs · SDK · Examples · Runs · GitHub. Add **Console** only once the console is
public and useful.

**Not in the nav:** Dev containers, Workspaces, VS Code, Cloud IDE.

---

## 2. Hero

### Copy

- **Eyebrow** — Open-source runtime for agentic development
- **H1** — Turn agent work into reviewable engineering work.
- **Subhead** — Sealant gives coding harnesses a self-hosted sandbox to work in, then turns every
  run into a structured record: code changes, checks, terminal output, artifacts, browser evidence,
  and the source trail behind the result.
- **Primary CTA** — Star on GitHub
- **Secondary CTA** — Run the demo
- **Tertiary link** — Read the SDK docs
- **Trust chips** — `Open source · Self-hosted · Bring your own harness · Replayable runs`

CTAs stay developer-native (star, docs, SDK) — not "book a demo" or "sign up."

### Visual — happy-state run review

Use the **review overview** screenshot style (not the sandbox-creation UI), in a confident
happy state. Soften or remove red/yellow items here.

```text
acme/billing-service / #5204

Rounding fix ready for review

Checks passing
Evidence current
Diff ready
Run audit available
```

Main panel:

```text
What changed

Computed the discount on the subtotal and rounded the final total once,
using each currency's minor-unit scale and the provider's round-half-even rule.

3 files · +41 / -22 · no schema, dependency, or provider-contract changes
```

Review questions:

```text
01 Reported discrepancy       Direct evidence
02 Unaffected orders          Direct evidence
03 Currency rounding          Verified
04 Regression coverage        Added
```

Right rail:

```text
Evidence used

Stripe currency documentation
Payment-provider rounding specification
Issue #5187 reproduction
Baseline order snapshot

8 sources · 5 checks · 200 repeated runs
View source trail
```

In-screenshot CTA:

```text
Review run
```

**Not in the hero:** "Open in VS Code," "SSH," or any editor/access plumbing. Those belong in §7.

---

## 3. Model strip

Directly under the hero, the simplest model on one line:

```text
Create a sandbox  →  Run a harness  →  Replay the record  →  Review the change
```

Supporting copy:

> One runtime model for code agents, QA agents, CI repros, dependency updates, and custom harnesses.

---

## 4. The run is the product surface

**Layout:** review/detail screenshot left, feature copy right.

- **H2** — Every run comes back with the evidence attached.
- **Body** — A Sealant run is more than a transcript. It keeps the change, the commands, the checks,
  the artifacts, the source trail, and the observations that explain how the result was produced.

**Feature bullets**

```text
Full diff
See exactly what changed, with file context and generated patches.

Run audit
Replay the ordered history of commands, output, processes, files, and artifacts.

Evidence trail
Link the result back to the sources, snapshots, browser traces, and commands used.

Review questions
Turn ambiguous parts of the run into focused human review instead of another wall of logs.
```

**Visual:** the "Currency rounding" detail screen. Nuanced statuses ("not executed," "needs
follow-up") are fine here — this section is about review depth.

---

## 5. Build on the SDK

**Layout:** copy left, code block right.

- **H2** — Build your agent on a runtime, not container glue.
- **Body** — Create a live sandbox around a real repository, run the harness you already use, stream
  progress while it works, and keep the record after the sandbox is gone.

**Code block**

```ts
const sandbox = await sealant.sandboxes.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
})

const run = await sandbox.harness.run(
  "Round invoice totals once, after applying the discount."
)

await run.record.replay()
```

Below the code block:

```text
Bring OpenCode, a custom harness, a CI worker, or your own agent loop.
```

---

## 6. What the record captures

**Layout:** 6-card grid.

- **H2** — A structured record, not a pile of logs.

**Cards**

```text
Terminal I/O
Byte-exact command output, attached to the run that produced it.

File changes
Added, modified, deleted, and renamed files with reviewable patches.

Processes
Lifecycle, exit codes, signals, timeouts, and supervised child processes.

Artifacts
Reports, logs, screenshots, generated files, and other retained outputs.

Network activity
Outbound requests associated with the run that made them.

Browser evidence
Screenshots, DOM snapshots, navigations, and browser-generated network traces.
```

Make the **Browser evidence** card visually special — it's a key wedge (browser evidence inside the
recorded run, not browser automation as a side product).

---

## 7. Real sandboxes & console

The sandbox GUI lives here — on the page, but below the fold and below the run.

**Layout:** sandbox console screenshots left (Create sandbox spec + sandbox summary/runtime), copy
and feature list right.

- **H2** — The sandbox is a real development environment.
- **Body** — Sealant creates a live, disposable environment around a repository: code, dependencies,
  harness, processes, runtime commands, and services. Use the SDK for automation or the console to
  create, inspect, restart, and enter sandboxes.

**Feature list**

```text
Create from repo, branch, or commit
Choose harness, OS, runtime, packages, and launch commands
Stream lifecycle events and runtime status
Open the live sandbox over SSH, VS Code, or Cursor
Stop, restart, expire, or garbage-collect when done
```

**Human-access line:** Open the live sandbox whenever you want to inspect, guide, or extend the run.

**Phrasing**

- "Open the live sandbox in your editor." — not "Dev containers for VS Code."
- "Create sandboxes from familiar repository specs." — not "Daytona alternative."

---

## 8. One runtime, many shapes of work

**Layout:** tabs or cards — Coding agents · Browser QA · CI repros · Dependency updates.

- **H2** — The same loop fits many kinds of agent work.

**Card 1 — Coding agents**

> Give a harness an issue, get back a change, checks, artifacts, and the full run record.

```text
sandbox → harness run → reviewable change
```

**Card 2 — Browser QA**

> Run the app, exercise a real browser flow, and keep screenshots, DOM snapshots, and network evidence.

```text
sandbox → browser run → evidence-backed test
```

**Card 3 — CI repros**

> Recreate a failing job in a clean environment and keep the commands, logs, files, and failure state.

```text
sandbox → failing command → replayable repro
```

**Card 4 — Dependency updates**

> Let a harness update packages, run checks, collect artifacts, and present the exact diff.

```text
sandbox → update run → reviewed patch
```

---

## 9. Open-source & self-hosted

Framed positively — not a fear/lock-in section.

- **H2** — Run it where your code already lives.
- **Body** — Sealant is open-source and self-hosted. Run the daemon inside your own infrastructure,
  connect the harnesses you already trust, and build products on top of the same public SDK.

**Three cards**

```text
Open source
Inspect it, fork it, self-host it, and build on it.

Harness-neutral
Use OpenCode, custom agents, CI workers, or your own loop.

Product-ready records
Expose the run record through your own UI, PR flow, QA tool, or internal platform.
```

---

## 10. Final CTA

- **H2** — Give your next agent run a real environment — and a record worth reviewing.

**Buttons**

```text
Star on GitHub
Read the docs
Run the demo
```

**Footer links**

```text
GitHub
Docs
SDK
Examples
Discord / Community, if you have it
```

---

## Full page in one wireframe

```text
┌──────────────────────────────────────────────────────────────┐
│ Sealant                         Docs SDK Examples GitHub     │
├──────────────────────────────────────────────────────────────┤
│ Eyebrow: Open-source runtime for agentic development          │
│                                                              │
│ Turn agent work into reviewable engineering work.             │
│                                                              │
│ Sealant gives coding harnesses a self-hosted sandbox to       │
│ work in, then turns every run into a structured record...     │
│                                                              │
│ [Star on GitHub] [Run the demo] [Read SDK docs]               │
│                                                              │
│                       [Hero: happy-state run review UI]       │
├──────────────────────────────────────────────────────────────┤
│ Create a sandbox → Run a harness → Replay the record → Review │
├──────────────────────────────────────────────────────────────┤
│ Every run comes back with the evidence attached.              │
│ [Run review detail screenshot] [Full diff / audit / evidence] │
├──────────────────────────────────────────────────────────────┤
│ Build your agent on a runtime, not container glue.            │
│ [Copy]                                  [SDK code block]      │
├──────────────────────────────────────────────────────────────┤
│ A structured record, not a pile of logs.                      │
│ [Terminal] [Diffs] [Processes] [Artifacts] [Network] [Browser]│
├──────────────────────────────────────────────────────────────┤
│ The sandbox is a real development environment.                │
│ [Sandbox console screenshots] [SSH / VS Code / runtime copy]  │
├──────────────────────────────────────────────────────────────┤
│ The same loop fits many kinds of agent work.                  │
│ [Coding agents] [Browser QA] [CI repros] [Dependency updates] │
├──────────────────────────────────────────────────────────────┤
│ Run it where your code already lives.                         │
│ [Open source] [Harness-neutral] [Product-ready records]       │
├──────────────────────────────────────────────────────────────┤
│ Give your next agent run a real environment — and a record     │
│ worth reviewing.                                              │
│ [Star on GitHub] [Read the docs] [Run the demo]               │
└──────────────────────────────────────────────────────────────┘
```
