# Stage 3 — Alignment (the grilling outcome)

_The decisions reached by working through the open questions together. This is the "same page"
record that the final plan is built on._

Five rounds of questions, 17 decisions. The big surprise that reshaped everything: **Sealant is
not a SaaS and not a revenue business — it's an open-source, self-hosted adoption play.**

---

## The decisions

### Identity & goal

| Decision | Answer |
|---|---|
| **What success means** | **Adoption, developer mindshare, community, and the founder's personal standing in the space.** Not revenue. |
| **Business / monetization** | **None, and not mentioned anywhere.** Maybe hosted "one day," but it does not appear in any positioning. The doc is a product/adoption plan, not a monetization plan. |
| **Deployment** | **Self-hosted only.** No managed cloud. **Remove "Sealant Cloud" and all hosted / two-sided SaaS framing** from the story. |
| **Who it's for** | **Indie / OSS developers** and **builders of AI coding products** — the star-givers, tinkerers, and people who need a recorded runtime they control. (Not enterprise/regulated/internal-platform as primary.) |
| **License model** | Open-source. (Open-core in spirit — everything OSS — with no paid tier today.) |

### The product shape

| Decision | Answer |
|---|---|
| **v1 hero** | **The live environment + harness run.** Give an agent a real sandbox, run its harness, get a result. The **execution record is the payoff**, not the lead. |
| **Public SDK surface** | **The fluent high-level SDK** (`sealant.sandboxes.create(...)` → harness run → `{ result, changes, artifacts, record }`). The low-level `runtime-client` becomes internal plumbing. The REST create contract gets reshaped to drop registry/tag friction. |
| **Harness model** | **Both modes** — one-shot (CI-style) and interactive (`run(prompt)` on a long-lived sandbox you can SSH into between tasks). **BYO-harness** stays a core principle. |
| **Execution record grade** | **Dev-grade now, audit-grade later.** Honest "evidence, not proof" (tamper-evident, best-effort) for developers now; privilege-separation + crypto digests + out-of-namespace spool sequenced as a later tier. |
| **Browser support (v1)** | **Headless, harness-driven, captured as evidence.** Agent drives a real Chromium in-sandbox via CDP; screenshots/HAR/DOM/navigations land in the run record. Rides the **existing** `openForward` channel + artifact store + egress proxy — composable, not greenfield. |
| **Hosting target (v1)** | **Local-first (Docker).** k8s/k3s later. (Matches code reality: Docker works, k8s adapters are stubs.) |
| **Tenancy / multi-tenant auth** | **Not Sealant's problem.** Self-hosted → one operator per deployment, inside their own trusted perimeter. No orgs/teams/quotas required; control-plane auth is the self-hoster's concern, not a multi-tenant identity system we must build. |

### Platform / products split

| Decision | Answer |
|---|---|
| **The split** | **Platform = "Sealant"** (runtime `sealantd` + the `.proto` + the public SDK), one project. **Products = separate repos**, each consuming the **published** SDK. The split already physically exists in the code (IPC-only, no vendored `.proto`). |
| **Product branding** | Products get their **own names + a "by Sealant" tag** and their own identity — _not_ "Sealant X" under an umbrella. (Drop the "Sealant Verify/Repro/Handoff" umbrella naming.) |
| **First flagship product** | **Handoff** (task → verified change + PR) — framed as the **proof-of-platform reference** that dogfights the SDK end-to-end, _not_ a revenue product. Heaviest to build, but proves the whole loop. |
| **Product family** | Handoff is first; Verify (behavior→proof→test) and Repro (report→runnable case) are committed roadmap, each its own "by Sealant" repo. |
| **OSS scope** | **Everything OSS.** Platform is one repo; each product its own repo on the public SDK — dogfooding from outside proves the SDK is real. |

### Adoption wedge

| Decision | Answer |
|---|---|
| **The 5-minute "wow"** | **The one-liner:** `create sandbox → run harness → replay the recorded run`. Fluent SDK DX + the execution record is the hero demo. Lightest path to a shareable moment, closest to working code. |
| **Marketing page** | Show **multiple examples** of the one-liner to demonstrate **versatility** — different harnesses and different jobs (coding agent, autonomous QA, bug repro, CI investigation, dependency updates…). |

---

## What this means for the narrative (deltas from today)

1. **Cut the cloud.** Remove the "Sealant Cloud" tier, "Join early access," and all managed/hosted/
   two-sided language. The only deployment story is **self-hosted, open-source**.
2. **Cut the monetization subtext.** No pricing, no enterprise, no "book a demo." The CTAs are
   "star the repo," "read the docs," "build on it."
3. **Reconcile the README.** Retire the "sandboxes + issue workflows" two-loop contract; adopt
   **sandbox + run + harness** as the primary nouns, with **issue-to-PR demoted to a product
   (Handoff, by Sealant)**.
4. **Make the fluent SDK real or stop showing it.** The hero `sandboxes.create(...).harness.run()`
   must exist as the public SDK (it doesn't today). This is the single most important build.
5. **Make the record consumable.** The "execution record" is the payoff of every demo, but its read
   side is unbuilt (folds throw `Unimplemented`, inspector pages redirect to JSON). The replay
   experience is what makes the demo shareable — it has to work.
6. **Honesty as a feature.** For an OSS/adoption audience, the honest-boundaries posture ("evidence,
   not proof"; "the tool reports, it does not judge"; tamper-evident not tamper-proof) is a
   trust-builder, not a weakness. Keep it explicit.
7. **Brand the products as standalone.** Give Handoff/Verify/Repro their own names and repos; the
   "by Sealant" tag signals they're proof the platform is real.

---

_Next: the one core doc — what we're building and why._
