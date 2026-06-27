# Marketing Site — Redesign Plan

_How to re-spine `apps/marketing` onto the locked product decisions. The current page is well-built
but sells the wrong story (Sealant Cloud, umbrella-named products, a two-sided SaaS funnel). This is
a **content/IA + copy re-spine on the existing visual system** — `DESIGN.md` stays; the narrative
changes._

Method: 5 divergent redesign approaches → a 3-lens judge panel (first-time dev / skeptical OSS
hacker / design steward) → one synthesized blueprint. The winning spine was **"the missing
runtime" manifesto** (best on design-fidelity and on the skeptical-OSS lens whose stars _are_ the
success metric), with the **one-liner → live-to-recorded hero** grafted in to fix its 5-second
clarity, and the **execution record as the climax**.

> Companion: `SEALANT-PLAN.md` (the decisions this serves). Section references like "§7" point there.
>
> **Visual identity:** governed by **§10 — "Evidence on file"** (added after a frontend-design pass).
> It changes the page's main instrument. Wherever a section below says **"CodePanel,"** read it as the
> **Run-Record Exhibit** — *except* the three places a dark terminal is honest: SSH (§4.8), Quickstart
> (§4.12), and the indictment foil (§4.3).

---

## 1. What this redesign optimizes

For an **adoption play**, the page has exactly two jobs: (1) a **first-time developer understands
what Sealant is in 5 seconds and hits a "whoa" within one viewport**, and (2) a **skeptical OSS
hacker trusts it** — no vaporware sold as shipped, no SaaS smell, no lock-in. Everything below
serves those two. The CTA we are optimizing is **a GitHub star**, not a signup.

## 2. The spine

A **builder-to-builder argument**: the agent era shipped frameworks that decide _what_ to do, but
left a hole where the work should happen and a void where the truth should be — and **Sealant is
the open-source, self-hosted runtime that fills both.** The page leads with the plain definition,
_then_ picks the fight, and proves it instantly with a hero panel that types the one-liner and
**resolves it into a real recorded run**. The execution record is the soul and the climax; the
one-liner is the literal spine, repeated across many jobs to show versatility.

## 3. The shape at a glance

| # | Section | Job | Serves |
|---|---|---|---|
| 1 | **Hero** — defined, then argued, shown as a live run | What it is in 5s + the wow above the fold | adoption · hero=env+run · record=payoff |
| 2 | **Thesis strip** — "Frameworks decide. The runtime delivers." | One quotable line; the three nouns | nouns sandbox·run·harness |
| 3 | **The indictment** — what you hand-roll today | Make the gap felt; wall-of-logs vs record | why it exists (§3) |
| 4 | **The model** — a sandbox you enter, a run you keep | The two-noun mental model | nouns (§5) |
| 5 | **One call, many jobs** — versatility gallery | The adoption wedge as a repeatable pattern | wedge / 5-min wow (§11) |
| 6 | **The record** — it reports, it does not judge | The soul; the signature panel; the climax | record=soul, honesty (§5,§7,§8) |
| 7 | **Browsing as recorded evidence** — the differentiator | The wedge nobody frames, honestly in-progress | browser (§8), honesty |
| 8 | **Not a black box** — step in over SSH | Anti-black-box, anchored in a _shipping_ capability | human access (§8) |
| 9 | **One contract, one SDK** — the platform backbone | Composable, multi-language, lock-in-free | public SDK, no lock-in (§8,§10) |
| 10 | **What Sealant is NOT** — boundaries are the feature | The credibility climax | honesty-as-feature (§7) |
| 11 | **Built in the open** — Handoff (by Sealant), proof of platform | The split as strategy; honest product status | products split (§6,§9,§13) |
| 12 | **Quickstart** — your first recorded run | Convert understanding → action, truthful to today | wedge made literal (§11) |
| 13 | **Final CTA** — adopt the runtime | Close on adoption asks only | adoption (§2,§11) |

> **Editorial note on length.** 13 argued sections is longer than today's already-long page and
> risks fatigue. The hero must carry the wow alone (it does). If we want a leaner v1, the
> **minimum-shippable core is §1–6 + §10–13** (defer §7 browser, §8 SSH, §9 contract to a
> fast-follow). Recommend shipping the full arc but keeping §7–9 tight.

---

## 4. Section-by-section spec

### 1 · Hero — the runtime, defined then argued, shown as a live run
- **Copy.** Eyebrow: `Open-source runtime for AI dev agents`. Headline leads with the **definition,
  not the accusation**: _"The runtime under your agent. A sandbox to work in, a recorded run to
  keep."_ Subhead lands the gap, then the promise: _"Your agent decides what to do. Nothing gives
  that work somewhere real to happen — or tells you what actually happened. Sealant is the
  open-source, self-hosted runtime that does both: one call spins up a real sandbox around your
  repo, runs your harness in it, and hands back a structured run you can replay. Bring your own
  agent. Keep your code. Read the evidence yourself."_
- **Visual.** Left: copy + CTAs (**primary "Star on GitHub"** with the GitHub mark + cobalt-lift;
  secondary "Read the quickstart") + a quiet mono trust line `TypeScript SDK · self-hosted ·
  open-source`. Right: the **signature run-record panel** (the one reserved cobalt-lift besides
  primary buttons). On load it scroll-types the canonical call
  `sealant.sandboxes.create({ repository, harness }).harness.run(prompt)` destructuring
  `{ result, changes, artifacts, record }`, then **resolves in place** into the recorded run: a
  dot+word status (`Completed · observed`), a few hairline mono evidence rows
  (`process.exited · 14 tests passed`, `file.modified · src/checkout.ts`, `net.request ·
  api.stripe.com`) each with an **Observed** provenance tag, a diff peek with 2px green/red
  edge-marks, and a quiet **`Replay ▸`** control that re-folds the rows.
- **Two mandatory fixes vs the current hero:** remove the decorative cobalt radial behind the text
  (`DESIGN.md §6` bans decorative gradients); replace the banned verdict footer **"Checks passed"**
  with observation-only copy.
- **No-JS / reduced-motion:** render the resolved record **statically and fully legible** — the
  static panel must carry the whole argument with zero animation.

### 2 · Thesis strip
Replaces the neutral `CapabilityStrip` word-list with an **argument**: one typeset sentence —
_"Planners and harnesses decide WHAT. Sealant owns WHERE it runs and WHAT actually happened."_ —
plus the three nouns in JetBrains Mono: `sandbox · run · harness`. Full-width band on `--sw-bg`,
hairline top/bottom, generous space. **Not** pills/chips (type does the work).

### 3 · The indictment — what you're doing today
Make the normalized pain felt (from §3 of the plan): _"You `docker run` and hope it's isolated. You
scrape a wall of terminal text to learn what the agent did. You have no clean before/after. When it
hangs, you can't step in. You rebuild this for every agent, every model, every project."_ Close:
_"Containers give you isolation. They don't give you the developer-work model around it."_
- **Visual.** Pain lines as a rhythm of **cobalt left-edge callouts** (reuse the `border-l-2`
  primitive) — no red/amber flooding. Beside them, a deliberately **dimmed, unappealing
  wall-of-`agent.log`** fragment vs the lifted record motif, joined by one quiet label: _"same run,
  read instead of scraped."_ This folds the "wall of logs vs record" emotional contrast in early so
  the page argues even for readers who skip code.

### 4 · The model — a sandbox you enter, a run you keep
The constructive resolution: _"Two nouns. Everything else serves them."_ Sandbox = the live
disposable environment (code, harness, processes, files, services) you can SSH into; Run = the
durable output (what it produced + the structured history of how). Tagline: _"The sandbox is where
the work happens. The run is what you keep."_
- **Visual.** Reuse the two-card `ModelCard` pattern with the `{ harness, ssh, files, processes } =
  sandbox` and `{ result, changes, artifacts, record } = run` mocks; subtly emphasize `record` as
  the spine.

### 5 · One call, many jobs — the versatility gallery
The adoption wedge as a repeatable pattern (§11). Header: _"One runtime. Many shapes of work."_ The
`create → run → replay` scaffold stays **byte-for-byte fixed and highlighted**; only `repository`,
`harness`, `prompt` re-type per job — **the invariance of the call is the argument.**
- **Jobs (tabs, mono segment selector — not filled pills; cobalt marks only the active label):**
  Coding agent fixes a failing test · Autonomous QA drives a checkout flow in a browser ·
  Reproduce a failed CI run · Land a dependency update · Investigate a flaky build.
- The record footer re-resolves to **job-appropriate observed evidence, never a verdict**: QA →
  `screenshots: 4`; repro → `failure reproduced`; dep update → `lockfile changed · checks observed`;
  coding agent → `3 files changed · 14 tests passed · observed`.
- A small inline **one-shot ↔ interactive** toggle on the coding/QA examples surfaces both harness
  modes. **No-JS:** degrade to a labeled vertical stack of all five snippets. Replaces the current
  `USE_CASES` chip-cloud with runnable code.

### 6 · The record — the soul
The climax. _"A wall of terminal text is not a record."_ Sealant captures process lifecycle,
byte-exact I/O, file changes, network, and artifacts as **one ordered, correlated, replayable
stream — queried, not parsed.** Principled lines (verbatim in spirit): _"It reports; it does not
judge. No scores. No safe-to-merge. You decide what the evidence means."_ and _"Every fact carries
how it was captured — Observed, Inferred, or Unknown. Replay is a pure re-fold of an append-only
log — not a promise to recreate arbitrary external systems."_ Carry a near-term honesty note: **the
run inspector / replay UI is being built now.**
- **Visual — the one net-new build that matters most:** render the **signature LIGHT/warm
  run-record panel** that `DESIGN.md` calls "signature" but the current page _never builds_ (today
  only dark `CodePanel`s exist): recording pulse + mono run id, dot+word statuses, hairline mono
  evidence rows with **provenance tags as real data**, a diff peek with 2px edge-marks, and a
  `Replay ▸` re-fold. Build it **once as a reusable `@sealant/ui` component** — it unlocks the
  hero, the versatility footers, the browser variant, and the final CTA.

### 7 · Browsing as recorded evidence — the differentiator (in-progress)
The wedge nobody frames, placed **mid-page, never the hero** (leading with it inverts the plan's own
§11/§12 sequencing). _"The agent needs the web. The web should leave evidence."_ A headless Chromium
the harness drives **inside the sandbox** — auth flows, UI checks — captured into the **same run**:
screenshots, DOM snapshots, navigations, the network it generated. Honest line: _"It composes
primitives we already have — the tunneling channel, the artifact store, the egress proxy. In
progress, and we say so."_
- **Visual.** A record-panel variant whose timeline interleaves browser evidence under one run id: a
  navigation event, a small **screenshot artifact thumbnail beside its correlated `net.request`
  rows** (this is the shareable image), a DOM-snapshot row, and one **amber `DOM assertion: not run`
  edge** to demonstrate honest provenance. `InDevBadge` in the header, not hidden. No fake product
  UI — just the evidence rows it emits.

### 8 · Not a black box — step in over SSH
Advance the anti-black-box stance into a **genuinely-shipping** capability (the most-complete path
today, §12) to anchor credibility. _"Automation when it works. Direct access when it doesn't."_ SSH
into the same live sandbox, fix the missing dep / occupied port / hung process, let the work
continue — _"Same repo, same processes, same task, same record. Your keystrokes land in the same
run."_ Editor Remote-SSH works through the same path.
- **Visual.** Reuse the existing SSH terminal `CodePanel` (`git diff --stat`, `ps -ef`, `pnpm test →
  14 tests passed`) largely as-is + a cobalt left-edge callout for the tagline.

### 9 · One contract, one SDK — the platform backbone
The architecture that makes the runtime composable, multi-language, and lock-in-free (the strongest
graft from the "build-on-it" approach). _"You import the SDK; the SDK speaks the contract; the
contract is the single source of truth."_ The primitives are defined once in the Protobuf control
protocol over the local socket; the **fluent SDK is the public surface** on top of the low-level
client; the same schema generates typed clients in other languages.
- **Visual.** Reuse the `MissingRuntime` vertical-stack geometry: `Your code → Fluent SDK
  (@sealant/*) → Wire contract (.proto) → sealantd runtime`. Beside the contract layer, a fan of
  language tags: **TS solid; Go/Py/Java dashed + "planned, from the same contract."**

### 10 · What Sealant is NOT — the boundaries are the feature
The credibility climax; the page's most quotable, lowest-decoration moment (from §7). Sentence-case
denials, each one line + a mono qualifier:
- _Not an agent or a model — bring your own._
- _Not just Docker — containers isolate; we add the work model._
- _Not a hosted service — self-hosted only, your code never leaves your infra._
- _Not a judge — evidence, not verdicts._
- _Not yet tamper-proof — tamper-evident, and we say so._
- _Not a deterministic time machine — replay re-folds the run's own history._
- **Visual.** A clean two-column hairline-divided list. No tinted panels, no alarm color — depth and
  type only, cobalt on linked terms.

### 11 · Built in the open — Handoff (by Sealant), the proof of platform
The split as strategy, not a catalog: _"The platform is the point. The products are the proof."_
Each product is its **own open-source repo on the public SDK, tagged "by Sealant."**
- **Handoff (flagship, building now):** one prominent card — small mono `by Sealant` tag, **amber
  "Building now"** status, a chip-row of the primitives it consumes (sandbox + harness + files +
  checks + artifacts + record), a snippet that is visibly the same `create/run` pattern wrapped and
  **ending in a PR link**, and a single **"Watch the repo"** CTA. Framed as proof: _"if Handoff
  works, the platform is real."_
- **Verify · Repro:** two visibly **quieter** cards below, hollow-ring **"On the roadmap"** status,
  one line each (Verify: behavior→proof→test; Repro: report→runnable case). **No "Explore" link, no
  use-it CTA** — they have zero code today.
- **Kills the page's single biggest honesty violation** (three co-equal products with "Explore"
  links implying all ship today) and drops the umbrella naming entirely.

### 12 · Quickstart — your first recorded run
Convert understanding into action while the one-liner is fresh — the real conversion event for an
adoption play. **Numbered, copyable, and truthful to what runs today** (the create → build → launch
→ SSH path, §12): clone & run `sealantd` locally on Docker, install the SDK, paste the hero
one-liner, open the run. End: _"Five minutes to your first recorded run."_
- **Visual.** A dark terminal `CodePanel`, each block independently copyable, mirroring the hero
  panel geometry so the page visually closes the loop it opened.
- ⚠️ **Load-bearing for credibility:** these commands must be **copy-paste-correct against the
  current codebase**. Verify the package name and daemon launch command before ship (see open
  questions).

### 13 · Final CTA — adopt the runtime
Close on adoption asks only. Headline: _"The runtime layer the agent era skipped. Build on it."_
CTAs: **"Star on GitHub"** (primary), **"Read the docs"** (secondary). Mono trust line. Echo the
record motif faintly with a single inert resolved run-record card so the page **ends on the artifact
it sold.** Reuse the existing rounded panel at **`shadow-md` (not cobalt-lift** — that stays
reserved); **remove the decorative cobalt radial.**

---

## 5. The shell: nav, footer, meta

**Nav.** Keep Brand + ThemeSwitcher. Replace the header **"Start building" → "Star on GitHub"**
(GitHub mark, cobalt-lift kept, optional live star count). Replace the link set with spine-aligned
anchors: **Why** (`#indictment`) · **Versatility** (`#jobs`) · **Products** (`#products`) · **Docs**
(repo, external) · **GitHub** (repo, external). No nav link may imply hosting.

**Footer.** **Remove the "Company" column** (About/Contact `#` dead links read as a sales org).
Replace with a **Project** column: License · Roadmap · Changelog · Discussions (→ repo). Replace the
umbrella **Products** links with: **"Handoff (by Sealant) — building now"** + a single muted
**"Verify · Repro — roadmap"** line. Keep **Platform** (lead with Quickstart, SDK reference, add
Execution record / Architecture). Re-spine the brand blurb to foreground the record: _"The runtime
the agent era skipped — a real environment to work in, and a trustworthy, replayable record of what
happened. Open-source, self-hosted, yours."_ Net shape: **brand · Platform · Products (by Sealant) ·
Project** — no company/contact, no sales surface, no hosted hints.

**Meta / social.** Keep the strong title (optionally tighten to _"Sealant — the open-source runtime
for AI dev agents"_). Re-spine the description to the new hero promise + record-as-payoff. **Add
OG/Twitter card meta (currently absent)** — `summary_large_image`, with an `og:image` of the
signature run-record panel (the screenshot/link that earns the next star, once the inspector mock
exists).

## 6. CTA system (one, repeated with discipline)

- **Primary, everywhere:** **"Star on GitHub"** — the single filled cobalt-lift button, GitHub mark,
  optional live star count. The shareable action that compounds mindshare.
- **Secondary:** "Read the docs" / "Read the quickstart" (outline).
- **Tertiary, contextual** — always _watch/read/replay_, never _use/buy_: "Replay this run ▸" on the
  hero record, "See the SDK reference," "Browse the example one-liners," **"Watch the repo"** on
  Handoff, "Follow on GitHub" on Verify/Repro.
- **Banned entirely:** pricing, "book a demo," "contact sales," "sign up," "join early access,"
  email capture, and **"Start building" as a button verb.**
- Implied funnel: **understand the runtime → copy the one-liner → star the repo.**

## 7. Cut / Keep / Add

**Cut**
- The entire **"Where it runs"** section — the **Sealant Cloud** card, **"Join early access,"** the
  `Cloud` icon, every hosted/managed/two-sided hint. (Self-hosted is restated as a _boundary_ in §10
  and made real in the Quickstart.)
- The **umbrella product naming** + three co-equal "Explore" cards + "Explore all products."
- **"Start building"** as the primary CTA verb (header, hero, final).
- The neutral **`CapabilityStrip`** word-list → replaced by the thesis strip.
- The standalone **"Controlled execution"** dark section → its points fold into §6/§10 so the record
  stays the page's single dark climax.
- The standalone **`HarnessNeutral`** section → folds into §5 (run across harnesses) and §9.
- The **`USE_CASES`** chip-cloud → superseded by the runnable versatility gallery.
- The standalone **FAQ** → absorbed into §10 + inline asides; **delete the FAQ line "Managed
  execution can use the same SDK…"** (hints at hosting).
- The **decorative cobalt radials** behind hero text and final CTA (`DESIGN.md §6`).
- The banned **"Checks passed"** hero footer.

**Keep**
- The **`CodePanel`** component + dark terminal aesthetic — but **narrowed** (per §10) to **SSH (§4.8),
  Quickstart (§4.12), and the §4.3 indictment foil only.** Everywhere it currently appears as the
  hero/feature visual, it is replaced by the **Run-Record Exhibit** (§10).
- The execution-record **`TIMELINE`** mock + dot+word footer (promoted to the climax).
- The **SSH terminal peek** + "Automation when it works…" callout (today-real, on-message).
- The two-card **`ModelCard`** sandbox/run pattern with the destructure mocks + cobalt member
  highlighting.
- The **`MissingRuntime`** stack geometry (repurposed as the contract backbone).
- The hero **one-liner content** (verbatim) as the page's literal spine.
- The **`Reveal`/motion primitives**, `Container/Eyebrow/Display/SectionHead` type system, warm
  canvas + dot-grid, cobalt-lift (reserved), `useReducedMotion` discipline, `InDevBadge`, the
  `border-l-2` callout.

**Add**
- The **definition-first headline clause** before the accusation (the clarity fix).
- The **live-to-recorded hero panel** (type the one-liner → resolve into a real record + `Replay ▸`
  + Observed tags).
- The **signature LIGHT run-record panel** as a real reusable `@sealant/ui` component (unlocks hero,
  versatility footers, browser variant, final CTA).
- **Provenance tags** (Observed/Inferred/Unknown) as a tiny mono micro-component.
- The **thesis strip**, the **indictment** (callouts + wall-of-logs contrast), the **versatility
  gallery**, the **browser-as-evidence variant**, the **contract backbone** section, the **"What
  Sealant is NOT"** section, the **copyable Quickstart**.
- **Per-capability status markers** (in development / observe-only today / planned from the same
  contract / building now / on the roadmap) — reuse `InDevBadge` as a status vocabulary.
- **OG/Twitter** social-card meta.

## 8. Build sequencing & risks

**The honest framing of the build:** this is **not** a pure re-spine. The emotional payload (hero
live-to-record panel, the signature light inspector, replay re-fold, versatility re-type) is
**net-new stateful/animated code** on a page that today has _zero_ client interactivity. Treated
carelessly it reads as the exact vaporware this audience punishes. Mitigations, in order:

1. **Build the signature run-record panel first**, as a reusable component. It is the spine of four
   sections; everything else is cheaper once it exists.
2. **Static-legible first.** Every animation (hero type-on/resolve, versatility re-type, replay
   re-fold) must degrade to a fully-legible static panel under `prefers-reduced-motion` / no-JS. The
   static panels must carry the argument alone. Consider **shipping static, layering motion later.**
3. **Loud "building now" framing** on the inspector/replay/Handoff surfaces (they are §12 near-term
   / zero-code). If a dev clones the repo and finds replay or Handoff not real, it inverts the
   page's own honesty thesis. Mocked records are labeled illustrative; the Quickstart promises **only
   what runs today.**

**Other risks:** the manifesto voice can tip into preachy — every opinion must cash out immediately
in copy-pasteable SDK code, sentence-case, concrete (concede limits in §10 before the reader can);
13 sections risk fatigue (the hero must carry the wow, and §7–9 stay tight or the leaner core ships
first); cobalt-lift must stay reserved (final CTA at `shadow-md`); **Quickstart correctness is
load-bearing** and must be verified against the codebase before ship.

## 9. Open decisions for you

These are genuinely yours; they change the build, not just the copy:

1. **Animation now, or static-first?** The single biggest build call. Recommend shipping the
   static-legible record panels first and layering the type-on/resolve/replay motion as a
   fast-follow — lower vaporware risk, faster to live.
2. **Product names.** Keep working names **Verify / Repro** on the page, or hold them until their
   repos exist? (Brand convention is standalone names + "by Sealant.") And does a **Handoff repo**
   exist yet for "Watch the repo" to point at, or should it point at the main repo / a roadmap issue?
3. **Repo + star count.** Confirm `github.com/get-sealant/sealant` is the canonical public repo, and
   whether to wire a **live star-count** badge into the primary CTA.
4. **Quickstart truth.** I should verify the exact commands that run **today** (clone/launch
   `sealantd` on Docker, the SDK package name, the one-liner) against the codebase so the conversion
   event is copy-paste-correct — want me to do that pass before/*as part of* implementation?
5. **Demo embed?** Recommend **no** live/recorded product demo (it would lean on the unbuilt
   inspector) — keep the page entirely code + record-panel driven. Confirm.

---

## 10. Design direction — "Evidence on file" (frontend-design pass)

_Added after running the redesign through a distinctive-design lens (3 subject-grounded visual
identities → a templated-default critique → synthesis). This section governs the visual identity and
**overrides the per-section "visual" notes** above where they conflict._

### The realization
Run the templated-default test honestly: for **any** dev-infra brief, the default hero is a dark
terminal code block — which is **exactly what the current page is.** That dark `CodePanel` is the
single most templated thing on the page. So distinctiveness does **not** come from a new palette or
font (the warm-canvas + cobalt + three-voice system is a *pinned* brief — keep it). It comes from
**finally shipping the one artifact `DESIGN.md` literally names "signature" but the page has never
built:** the **warm-light Run-Record Exhibit.** No other dev tool can render an "exhibit" because no
other dev tool keeps a sequenced, provenance-tagged, replayable record. The signature is the
product's own data model, rendered.

### The signature instrument — the Run-Record Exhibit
Build it **once** as a reusable `@sealant/ui` `<RunRecord>` component, parameterized by fidelity
(**full** / **inline-strip** / **inert**). It is the hero, the §5 versatility footers, the §6
climax, the §7 browser variant, and the §13 closer — **and it replaces the dark CodePanel as the
page's main instrument.** Four traits, each mined 1:1 from the real data model, that no dark code
block has:

1. **Corner seal** — a cobalt recording pulse + mono `run-id` + a capture timestamp. Marks it as
   *filed evidence* (= the durable telemetry spool + correlation id).
2. **Sequence rail** — right-aligned mono per-event numbers (`0001 0002 0003…`) down the left margin,
   like a ledger (= the real monotonic `(runId, sequence)` coordinate).
3. **Provenance as dot+word** on each fact — **Observed / Inferred / Unknown** (= the real
   `captureMethod` confidence field), rendered in `DESIGN.md`'s status grammar — **never a boxed
   pill/micro-stamp** (pills are banned).
4. **Hairline mono evidence rows + a diff peek** (2px green/red edge-marks, never floods) **+ a
   `Replay ▸`** control that re-folds the append-only rows in place (= replay as a pure fold of the
   log).

> **Build order is unchanged:** this is still "build the signature panel first" — but the panel is
> the light Exhibit, not a dark terminal. It's the vertical slice everything else depends on.

### Where the dark CodePanel still legitimately lives
Only three places, because in each a terminal is *honest*: **§4.8 SSH** (a real interactive session),
**§4.12 Quickstart** (literal copy-paste commands), and **§4.3 the indictment foil** (the dimmed
"wall of `agent.log` that fails to parse," shown as the thing the record beats). Everywhere else the
dark panel currently appears as a hero/feature visual, it is the light Exhibit.

### Catalog IA — eyebrows that reference real runs
Structure encodes truth: each section's eyebrow becomes a **real artifact reference**, not a
decorative label — `EXHIBIT C · run sbx_8m2k · 184 events`. Hard rule: an eyebrow must reference a
real run primitive (run-id + event count), never a generic word. The page reads as a small,
numbered **dossier of evidence you could file.** (The literal `EXHIBIT A–H` lettering is the one
*optional* flourish; the run-id reference is always-on — see founder questions.)

### Typography move — mono is the record's native language, but bounded
Keep `DESIGN.md`'s three voices and the semantic split. The move: **mono carries the evidence**
(sequence numbers, event names, offsets, run-id seal, provenance) **inside the exhibit**; **Inter
carries 5-second comprehension** in the claim that sits *beside* every exhibit; **Space Grotesk names
the exhibit**, one headline per section, with restraint. `DESIGN.md`'s core law — _the claim never
carries a value the exhibit doesn't show_ — is promoted from principle to **layout LAW**: reject any
section where the claim asserts a value the visible record doesn't prove. That is "reports, not
judges" made structural.

### Palette — zero new hexes
100% inherited from `DESIGN.md`. Warm canvas `#edeae4` is the gallery wall (exhibits float as
objects via soft shadow, never borders); pure `#ffffff` is reserved for the kept-record card; cobalt
`#2052cc` is the only brand color (the seal/pulse, the active provenance link, the one primary CTA),
never flooded; green-dot **Observed** dominates, amber marks exactly one **Inferred/not-run** moment
(the §7 "DOM assertion: not run" edge, the §10-boundaries honesty), red only for demonstrated
breakage.

### Motion budget — exactly two, static-first as a hard floor
Every record renders **fully legible with no JS and under `prefers-reduced-motion`** (offsets show
final values, the pulse becomes a static dot, `Replay` shows the already-folded rows). Exactly **two
motions** ship: (a) the **hero one-liner resolving into the Exhibit**, and (b) the **one ambient
grain of audacity** — a persistent **run-header in the sticky nav** (run-id + recording pulse + an
advancing `mm:ss.mmm` offset) so scroll subliminally reads as **replaying one run**, opening on
`sandbox.ready` (hero) and closing on `run.completed` (final CTA — the pulse stops, status resolves
to `Completed · observed`). No per-section reveals beyond these, no scroll-jacking, no full-height
gutter. **Ship static; layer the two motions as a fast-follow.**

### The one risk, and the one accessory removed
- **The risk (spend boldness here, nowhere else):** the sticky run-header playhead. Justified because
  it's the product's *actual data model used as navigation*, not metaphor — but it must stay
  hairline-quiet, single-accent, fully static-degradable, and **never required to understand what
  Sealant is.** Removable without breaking the page if it doesn't land.
- **Removed (the Chanel cut):** the deckled / torn-paper top edge on the record card. Kitsch; fights
  `DESIGN.md`'s "depth is one restrained soft shadow, no decorative chrome." The "kept artifact" read
  is already carried by the seal + rail + provenance dots. **The record should look filed, not
  distressed.**

### Net deltas to this plan
- The main instrument is the **Run-Record Exhibit**, not the dark CodePanel (governs §4.1, §4.5,
  §4.6, §4.7, §4.13; CodePanel narrowed per §7).
- Eyebrows become **real run references** (`run <id> · <N> events`).
- The §6 record build is the **`<RunRecord>` component with the four required traits** above.
- Add the **sticky run-header playhead** (ambient, optional, static-degradable) to §5/§8.
- Motion budget is **exactly two motions**; static-first is a **hard floor**, not a recommendation.

### Founder decisions this adds (beyond §9)
- **Ship the run-header playhead, or keep a pure static catalog** with the pulse confined to the hero
  exhibit? _(Recommend: ship it, static-first/ambient-only — the cheapest non-transferable signal
  that "this page is a run.")_
- **Illustrative labeling:** the Exhibit shows a *mocked* record while the real inspector is being
  built — an explicit "illustrative record" note on every exhibit, or only an `InDevBadge` on §6/§7?
  _(This is the line between distinctive and vaporware for the skeptical-OSS lens.)_
- **Catalog lettering:** expose literal `EXHIBIT A–H` letters, or keep only the run-id + event-count
  reference and drop the lettering to stay sober? _(Recommend: always keep the run-id reference;
  lettering is the optional flourish.)_

---

_Next step options: I can (a) turn this into a section-by-section implementation checklist against
`index.tsx`, (b) build the reusable `<RunRecord>` Exhibit + hero first as a static-first vertical
slice (the highest-leverage move — it unlocks five sections), or (c) draft the full copy deck for
every section. Your call._
