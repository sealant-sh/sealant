# Stage 2 — Core Feature Brainstorm (Developer's Perspective)

_What a developer who **uses** Sealant would want from the platform + SDK. Each feature notes
whether there's already a seed in the code, whether it belongs to the platform or a product, a
rough priority, and the open question to settle with you._

Priority key: **table-stakes** (must exist for the category to be credible) · **differentiator**
(why someone picks Sealant over raw Docker / a headless service) · **future** (real, but later).

---

## A. Sandbox & harness — the front door

### A1. Sandbox lifecycle SDK (create / inspect / stop / TTL) — _table-stakes · both_
> _"`sealant.sandboxes.create({ repository, harness })` gives me a live disposable env and a handle
> I can stop, restart, or let expire — no Dockerfiles, no container babysitting."_

The promise the marketing hero makes. The create path is real but REST-shaped (needs
`registryId` + `tag` + GitHub `sourceSelection`), and there is **no stop/terminate/restart/TTL/GC
anywhere** — launched containers leak. Without close-out, cost and capacity are unbounded.
**Q:** What is the canonical create API — the fluent one-liner or the REST contract? And who owns
teardown/idle-timeout/GC, since nothing does today?

### A2. Harness execution as a first-class verb (`harness.run(prompt)`) — _differentiator · both_
> _"Hand a configured coding harness a task, get back `{ result, changes, artifacts, record }` —
> the agent worker lifecycle managed for me."_

The headline differentiator ("run a harness instead of building your own agent worker loop"). The
boot supervisor already launches the harness as a managed PID-1 child with full I/O capture, but
there is no SDK-level `run(prompt)` returning a structured result; harness is baked into the image
boot contract, not driven interactively. **Q:** Is the harness driven once at boot, or repeatedly
via interactive `run(prompt)` during a sandbox's life? Where do harness API keys get injected? Is
BYO-harness a hard requirement?

### A3. Build pipeline DX: caching, reproducibility, build-to-ready SLA — _table-stakes · platform_
> _"Fast, reproducible builds — cached layers, pinned harness/tool versions, predictable
> build-to-ready time — not a cold `dnf`/`npm install` on every job."_

Every build recompiles with no image cache/dedup; harnesses install `@latest` (supply-chain +
reproducibility risk); registry publish runs host-side `docker load/tag/push` on a shared daemon.
**Q:** Build-to-ready SLA targets? Do we need caching/dedup + pinned harness versions + isolated
builders before GA? Is reproducibility a _marketed guarantee_?

---

## B. The execution record — the platform's soul

### B1. Trustworthy execution-record SDK (read models over the event log) — _differentiator · product_
> _"Query a run's record — timeline, scrollback, file diff, process tree, network-in-flight — at
> any `(runId, sequence)` coordinate, as structured data, not raw terminal text."_

The append-only log + pure-fold projections are production-shaped and tested, but the north-star
read models throw `TelemetryQueryUnimplementedError` and **none of it is exposed via API or SDK.**
**Q:** What's the developer-facing read surface — REST/SDK query API, streaming tail, both? Priority
order for the unimplemented folds (file tree vs process tree vs network vs live tail)?

### B2. Live event stream + at-least-once delivery — _table-stakes · platform_
> _"Subscribe to a run's typed event stream and trust I can reconnect-and-resume from a sequence
> without losing events."_

The whole "record" value prop rests on delivery integrity, but `high_water` advances on the first
broadcast attempt regardless of receipt, then segments are deleted — a slow/reconnecting SDK
silently loses events, with no resume-from-sequence command. **Q:** Does the platform need true
at-least-once (client ack + resume) before deleting spool segments, or is "durable until first
broadcast attempt" the accepted boundary? _This determines whether the record can be marketed as
authoritative._

### B3. File diff + artifacts as run output — _table-stakes · both_
> _"A clean before/after diff (added/modified/deleted/renamed + line-level patches) plus retained
> artifacts (logs, reports, generated files, screenshots) addressable by content hash."_

The fs crate gives sizes/hashes/paths and a net-change summary, but **no line-level patch text** is
generated, and external artifact backends (S3/GCS) are enumerated but only inline-bytea is wired
(won't scale to real logs/diffs). **Q:** Do we need real line-level patch artifacts, and when does
an external (S3) artifact backend ship?

### B4. Browsable run-inspector UI — _differentiator · product_
> _"A web run-inspector that renders diff-peek, trace timeline, scrollback, and validation views for
> a finished or live run — the 'evidence review' experience the design system was built for."_

The signature motif is mostly aspirational: diff/trace/validation routes redirect to a raw JSON
spec dump. The launcher is real; the **inspector — the thing that makes the record valuable to a
human — is not shipped.** **Q:** Is the inspector the core product surface for v1, and which views
ship first (given the read models they depend on are themselves unimplemented)?

---

## C. Browser support — the flagged primitive

### C1. Remote browser sessions in-sandbox (CDP relay + browser-as-evidence) — _differentiator · both_
> _"A harness (or human) drives a real Chromium in the sandbox — web-app auth flows, browser dev
> tools, UI verification — and the browsing is captured as part of the same recorded run
> (screenshots, DOM snapshots, navigations, network)."_

You flagged this; it's the one primitive marketed but unbuilt ("Browser sessions", _In development_).
The differentiated shape for an isolated-sandbox + execution-record platform is:
1. a headless/headful browser running **in-sandbox**;
2. its CDP/devtools port exposed to the developer's tools via the **existing `direct-tcpip`
   `openForward` channel** (exactly how VS Code Remote-SSH already tunnels);
3. browsing artifacts (screenshots, traces, HAR, DOM) written to the **content-addressed artifact
   store** and stitched into the run record;
4. network egress already observed by the proxy, **correlated to the browsing session.**

This turns browser activity into **first-class evidence** — unique versus a plain headless-browser
service. **Strong transport seeds already exist** (`openForward` as a ready-made CDP relay, the
artifact CAS, the egress proxy); no browser process management, CDP relay, or browser-evidence
schema exists yet. **Q:** What does "browser support" mean for v1 — (a) in-sandbox headless browser
the harness drives via CDP, (b) a remote interactive browser a human views/controls, (c) browser
activity captured as evidence, or all three? Which is the wedge? Does it ride the existing
`openForward` + artifact store or need a new browser-session subsystem?

---

## D. Access & interactivity

### D1. Interactive PTY / web terminal sessions — _table-stakes · both_
> _"Open a PTY-backed shell in a running sandbox (create/resize/close/attach), stream bytes to a
> real terminal or web terminal, with correct job-control (Ctrl-C hits the whole pipeline)."_

The daemon PTY runtime is solid (setsid/TIOCSCTTY, lossless attach channel) and the gateway maps
SSH shell→`openSession`. But the **TS SDK is missing typed methods** for
`openSession`/`closeSession`/`resizePty`/`listSessions` — interactive lifecycle is only reachable
via the low-level `request()` escape hatch. **Q:** Is a web-based terminal a committed surface?
Should the SDK ship typed session-lifecycle methods + a Node `stream.Duplex` over `Channel`?

### D2. Collaboration & sharing (sandbox access, session sharing, principal RBAC) — _future · product_
> _"Share a running sandbox or a recorded run with a teammate, grant scoped SSH/terminal access,
> have access decisions audited."_

The gateway is a real choke point doing principal×sandbox authz, but the API check is owner-only,
keys have no provisioning/revocation/hot-reload, and there's no sharing surface. Session
OBSERVE-mode exists in the protocol but isn't surfaced. **Q:** Is cross-user/team sharing (scoped +
audited) a launch requirement?

---

## E. Networking & control

### E1. Egress observation + egress POLICY/enforcement — _differentiator · platform_
> _"See every outbound request a run made AND set an allow/deny policy so an untrusted agent can't
> exfiltrate or reach disallowed destinations."_

"Policy belongs to the environment, not the prompt" is a stated stance, but today the proxy only
**observes** — no allowlist/denylist/block/rate-limit, and it's cooperative (bypassable). Privileged
transparent-capture + per-process attribution are vaporware. **Q:** Is egress _enforcement_ a
product requirement, or is best-effort observation enough? Do we commit to the privileged
transparent-capture path (eBPF/netns) the orchestrator can't even convey capabilities for today?

---

## F. Security, identity & tenancy (systematically deferred, interlocking)

### F1. Authentication & authorization (control plane + control socket) — _table-stakes · both_
> **The #1 gap.** The control-plane API has **no user-auth middleware** — `ownerUserId` is a trusted
> input, so any caller can create/read sandboxes for any user. The socket trusts every uid-passing
> peer equally. Better Auth exists but is **not integrated.** **Q:** What's the control-plane auth
> model (Better Auth session? API keys? gateway-injected identity?) and where does it live? Does the
> socket need a token/capability layer for least-privilege callers?

### F2. Multi-tenant isolation & tenancy model — _differentiator · product_
> The data model is **per-user only** (no org/team table), daemon limits are global not per-tenant,
> and the build queue is a single shared FIFO (a noisy tenant starves others). **Q:** What's the
> unit of tenancy and isolation (single-tenant per host? gVisor-enforced? one container = one
> daemon = one harness)? Org-level ownership? Per-tenant quotas + queue fairness?

### F3. Secrets management (encryption, redaction, injection) — _table-stakes · both_
> The DB stores ciphertext+key-id but performs **no encryption** (KMS is a caller TODO); runtime
> tokens are plaintext `-e` env to `docker run`; redaction is heuristic prefix-based and misses
> custom/opaque secrets; PTY keystroke input is recorded raw. **Q:** Is redaction best-effort
> hygiene or a compliance control? Where does the encryption key live? Is plaintext env injection
> acceptable, or do we need file-mount/secrets-manager?

### F4. Tamper-evident vs audit-grade integrity — _differentiator · platform_
> The defining tension: the record is marketed as "authoritative evidence" but is explicitly
> **tamper-evident only**, not tamper-proof against the default (root, shared-namespace) deployment.
> CRC32 is not cryptographic. **Q:** Is "tamper-evident best-effort recorder" acceptable GTM, or
> does the product _require_ the privilege boundary (separate unprivileged UID, user-namespaced
> containers, cryptographic per-record digests) before claiming audit-grade integrity? _This single
> decision splits the GTM: compliance/security buyer vs developer-convenience._

---

## G. Platform reliability & operability

### G1. Reconnection / session resumption / resilience — _table-stakes · platform_
> Everything is connection-scoped: a dropped control connection kills all PTY attaches/forwards/SFTP
> bridges, fails pending requests, ends the event stream; the SDK only retries the initial connect.
> **Q:** Is reconnect-and-reattach required, or is fail-closed acceptable for v1?

### G2. Job retry, DLQ handling & stuck-lease reclamation — _table-stakes · platform_
> `maxAttempts` is stored but **no code enforces it**; failures nack straight to DLQ with no
> backoff; the lease-reclaim function exists but is **called by zero production code**; nothing
> consumes the DLQ; at-least-once redelivery re-runs non-idempotent publish/launch (orphans).
> **Q:** What's the failure policy + DLQ runbook? How do we make registry-push/launch idempotent?

### G3. Observability & operability (health, metrics, command audit log) — _table-stakes · platform_
> `HealthReport` hardcodes several fields to zero/None; there's no structured audit log of control
> commands; feature kill-switches are in-memory, unauthenticated, non-persistent (any peer can flip
> network collection). **Q:** Which health fields are real vs placeholder? Is a tamper-evident audit
> log of control commands required? Should feature toggles be access-controlled + persisted?

### G4. Runtime backends beyond single-host Docker (k8s/k3s, persistence) — _future · platform_
> k8s/k3s adapters are 37-line throwing stubs despite being first-class in spec/DB/worker/marketing;
> the Docker adapter refuses persistent + no-network sandboxes; telemetry ingestion is docker-only.
> **Q:** Single-host Docker per worker at launch, or real cluster orchestration for GA? Are
> persistent/stateful workspaces committed?

---

## H. SDK & ecosystem

### H1. Multi-language SDK generation from the wire contract — _differentiator · platform_
> The single-source proto3 schema makes Go/Python/Java clients codegen-only work. But `buf.yaml` has
> no lint/breaking config, schema negotiation is exact-match (v2 daemon hard-rejects v1 clients),
> and there's no version handshake — **external SDKs can't ship safely yet.** **Q:** Is a public
> multi-language SDK a committed product? What backward/forward-compat policy do we commit to before
> the first external client ships?

### H2. Capability-aware SDK & pre-flight negotiation — _future · platform_
> Capabilities are honestly reported (`FeatureMatrix`) but the SDK doesn't gate calls by capability —
> a consumer can call `openSftp`/`openForward` against a daemon lacking the feature and fail at
> runtime. Some reports overstate reality (pidfd "supported" but signaling still uses `killpg`).
> **Q:** Should the SDK surface capability-aware typing / pre-flight gating, and distinguish
> "supported by kernel" from "actually wired and used"?

---

## I. Product loops

### I1. Issue-to-PR workflow execution engine — _differentiator · product_
> A flagship loop (= Sealant Handoff) with a **complete DB lineage schema**, issue import, and a
> board UI — but **zero execution engine** consumes the tables. The board is client-side `useState`
> (lost on reload); GitHub intake is fixtures (only Linear is end-to-end); no worker opens a PR.
> **Q:** Is issue-to-PR in scope for launch? MVP execution engine — who runs the change, who opens
> the PR, how is validation defined? Is the imported board a transient view or the system of record?

---

## Cross-cutting themes

1. **Narrative is ahead of implementation across the board.** Marketing, the README, and the
   shipped reality tell _three different_ product stories. **The single biggest pre-build decision
   is picking ONE canonical positioning** and reconciling docs before any external claim ships.
2. **Pervasive doc/code drift signals immaturity to anyone onboarding.** Trustworthiness of the
   platform hinges on the docs being trustworthy.
3. **The "trustworthy execution record" is the soul, but its trust chain has three weak links:**
   (1) delivery is not true at-least-once (no ack/resume), (2) tamper-evident not tamper-proof in
   the default deployment, (3) the read API/inspector that makes the record valuable is largely
   unbuilt. All three must be addressed coherently or the central claim is hollow.
4. **A clean platform/product split exists and should be leaned into.** The open question is which
   products are GA-committed vs positioning, and whether the SDK/runtime is publicly supported.
5. **Security & multi-tenancy are systematically deferred and interlock.** For any hosted/B2B/
   compliance positioning these are blocking and cannot be bolted on late.
6. **Lifecycle close-out is missing everywhere** (no sandbox stop/TTL/GC, no build retry, no DLQ
   consumer, no retention/GC). The system is good at _starting_ and _recording_ things, with no
   story for _reaping_ — acute the moment it runs unattended at scale.
7. **Linux-first / Docker-only / amd64 is the real operating envelope** despite spec/marketing
   implying k8s, arm64, persistence, clusters. The honest near-term product is narrower than the
   enums suggest.
8. **Browser support is net-new but has unusually strong transport seeds** — the differentiated
   framing ("browsing as recorded evidence in the same run") is achievable by _composing existing
   primitives_, if v1 scope is pinned.

---

## The twelve questions that change the product most (the grilling agenda)

1. **The ONE canonical product story** — harness-neutral "runtime for AI developer agents" vs
   "isolated sandboxes + issue-workflow review"? Primary noun set (sandbox + run + harness vs
   sandbox + issue workflow)? _Everything hangs on this._
2. **What is the developer-facing product** — the LAUNCHER, the RUN INSPECTOR, or the SDK/runtime —
   and which is GA at launch vs aspirational?
3. **What does "browser support" mean for v1** concretely, and does it ride existing primitives?
4. **Control-plane auth & authz model** — and where it lives. (Today any caller can be any user.)
5. **Is the execution record audit-grade or best-effort tamper-evident?** _Splits the GTM._
6. **True at-least-once telemetry delivery (ack + resume), or "durable until first broadcast"?**
7. **Is issue-to-PR (Handoff) in scope for launch, and what's the MVP engine?**
8. **Runtime/scaling target** — single-host Docker, or real k8s/k3s? Persistent workspaces?
9. **Who owns lifecycle close-out** (sandbox stop/TTL/GC, build retry, DLQ, retention)?
10. **Public supported multi-language SDK/CLI, or internal-only runtime?** Compat policy?
11. **Tenancy model** — per-user today; orgs/teams + quotas + sharing + RBAC for B2B?
12. **Are Verify / Repro / Handoff committed products or naming placeholders** — and which marketed
    primitives are GA vs "In development" so we stop selling vaporware?

---

_Next: Stage 3 — the grilling. I'll work through these with you until we're aligned, then write the
alignment summary and the final product doc._
