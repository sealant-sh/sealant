# Stage 1 — Codebase Study

_What Sealant actually is today, grounded in the code of both repos (`sealant-core` + `sealantd`), not the marketing._

Method: 17 parallel reader agents read the real source across both repos, then two synthesis
agents produced a capability/boundary map and a dev-perspective feature brainstorm. Every claim
below was verified against files, not READMEs. Maturity labels are honest: `working` /
`mixed` / `scaffold` / `placeholder`.

---

## 1. The one-paragraph thesis (what the platform really is)

Sealant is a **runtime for running and recording untrusted code — AI-agent or human — inside
isolated sandboxes, exposed through one stable contract.** Its true core is two layers that
already exist and work:

1. **`sealantd`** — a Rust PID-1 container daemon that owns process/PTY execution, signal/reaping
   semantics, filesystem and network evidence collection, and a durable, crash-recoverable
   telemetry spool — all reachable over **one length-prefixed Protobuf Unix-socket control
   protocol** whose `.proto` is the single source of truth for codegen.
2. **A TypeScript SDK seed** (`@sealant/runtime-client` / `@sealant/runtime-protocol`, v0.4.0)
   generated from that same `.proto`, plus an Effect-native composition/orchestration layer in
   `sealant-core` (build → publish → launch on Docker, RabbitMQ job queue, Postgres state,
   telemetry ingest, SSH gateway).

The platform's defining primitive is the **execution record**: every observed fact — process
lifecycle, byte-exact I/O with stream offsets, file diffs, network egress metadata — is minted at
one deterministic sequencing point, carries correlation IDs and honest provenance
(`captureMethod` + Observed/Inferred/Unknown confidence), and is replayable as a pure fold of an
append-only log. **Sealant reports facts and does not judge.** It supplies the environment and the
evidence, not the agent.

---

## 2. The platform / products split already exists in the code

The clean line the code already draws:

- **PLATFORM** = the `sealantd` daemon (Rust crates: `sealant-protocol`, `sealant-control`,
  `sealant-process`, `sealant-pty`, `sealant-telemetry`, `sealant-eventlog`, `sealant-fs`,
  `sealant-network`, `sealant-runtime-core`, `sealantd`, `sealantctl`) **plus** the generated wire
  SDK (`@sealant/runtime-protocol`) and the thin typed client (`@sealant/runtime-client`). These
  live in a **separate repo** — `sealant-core` vendors **no `.proto`** and pins the SDK at `^0.4.0`.
  The platform's job: run code in a sandbox, multiplex byte channels, emit a durable, correlated,
  provenance-honest execution record over one socket — **nothing product-specific.**

- **PRODUCTS** = everything in `sealant-core` that consumes that SDK: the sandbox
  composition/build/launch engine (`@sealant/sandboxes`), the control-plane API + RabbitMQ worker +
  Postgres state (`apps/api`, `apps/worker`, `packages/{db,rabbitmq,validators,api-contracts}`), the
  telemetry read-model pipeline (`packages/telemetry`), the SSH gateway, the web/mobile consoles,
  source/issue/auth integrations, and the **not-yet-built** Verify/Repro/Handoff and issue-to-PR
  engines.

The seam is **already physically enforced**: communication is IPC-only (never FFI), and
`runtime-client` is the only thing that knows the wire.

> **The real split decision is not "extract a platform" — the platform already lives in its own
> repo.** It is: _what additionally graduates from products into the platform SDK?_ The ambiguous
> middle is `packages/telemetry`, the sandbox **blueprint schema**, and the **execution-record read
> models** — generic enough to be SDK surface, but currently living in the product monorepo.

---

## 3. Capability inventory (what exists, with maturity)

### Platform capabilities (the primitives products consume)

| Capability | Maturity | Notes |
|---|---|---|
| **Control protocol** (`sealant-protocol` + `sealant-control`) | working | proto3 wire contract: 24 commands, 13 results, 12 event payloads, 18 error codes; 4-byte length-prefixed Unix-socket/stdio transport; byte-conduit multiplexing (`ChannelId`); `SO_PEERCRED` peer-uid auth; oversized-frame DoS defense; fuzz harness. Single cross-language contract. |
| **Process & PTY execution** | working | Spawns non-interactive processes + interactive PTY sessions in own process groups; dual-taps I/O as lossy-redacted telemetry **and** lossless backpressured byte channels; timeouts (SIGTERM→SIGKILL); signal/kill process groups; reaps orphans via subreaper; SFTP/TCP-forward conduits. |
| **Durable telemetry bus & event log** | mixed | One deterministic sequencing point; append-only, CRC32-checked, segmented on-disk spool with crash recovery, replay-on-restart, disk-bound eviction; priority-aware backpressure preserves Critical events. **Ack model is the weak link** (see §5). |
| **Filesystem & network evidence collectors** | mixed | Unprivileged SHA-256 baseline/final snapshots + inotify live watcher (inferred renames, overflow recovery); cooperative userspace HTTP/HTTPS-CONNECT egress proxy emitting per-request evidence; raw `direct-tcpip` forward. **Privileged eBPF/netlink/payload modes are inert schema only.** |
| **Daemon composition & PID-1 supervisor** (`sealantd boot`) | working | Boots container, clones repo with scoped short-lived creds, applies dotfiles, runs lifecycle steps, supervises the agent harness as a managed child, wires all subsystems behind one socket; configured by a `SEALANT_*` env contract. **Replaces the in-container sshd.** Baked into every image as `ENTRYPOINT ["sealantd","boot"]`. |
| **TypeScript runtime SDK** (`@sealant/runtime-client`) | working | Connects to / spawns `sealantd`; drives exec/PTY/stdin/signal/shutdown; multiplexes byte channels (attach/forward/sftp) with SSH-style half-close; `events()` as `AsyncIterable<EventEnvelope>`. **The seed of the eventual public SDK.** ~10 of 24 wire commands still lack typed convenience methods. |
| **Sandbox composition engine** (`@sealant/sandboxes`) | mixed | `SandboxBlueprint` → BuildKit Containerfile render+compile → OCI registry publish (Zot) → `docker run -d` launch (runc/runsc) → runtime-adapter selection → GitHub-installation scoped auth → Repology package standardizer. **k8s/k3s adapters throw "not implemented yet."** |
| **Control-plane API + worker + state** | working | Contract-first Effect `HttpApi` (`POST /v1/sandboxes`, OpenAPI emitted) → Postgres rows (blueprint→queued-attempt→build-job) → RabbitMQ pointer → background worker (lease-based at-least-once claim) compiles/publishes/launches + ingests telemetry. ~45 migrated Postgres tables (Drizzle). |
| **SSH gateway** (control-socket bridge) | working | One SSH entrypoint (`sbx-<id>@gateway`) for all sandboxes; pubkey-auth → resolve principal → API authorizes principal×sandbox → bridges SSH channels to daemon control commands (shell→`openSession`, `direct-tcpip`→`openForward` for VS Code Remote, sftp→`openSftp`). Does **not** dial an inner sshd. |
| **Telemetry read-model / run-inspector substrate** | mixed | Event-sourced ingest+query over the daemon stream: gap/drop detection, content-addressed artifact offload, byte-exact scrollback reconstruction by `streamOffset`, projections that are pure re-folds (projection == rebuild). **North-star folds (`getRunRollup`, `reconstructFileTree/ProcessTree/NetworkInFlight`, `tail`) throw `TelemetryQueryUnimplementedError`.** |

### Product candidates (what could be "Built on Sealant")

| Candidate | State today |
|---|---|
| **Run Inspector / Execution Record viewer** | Capture/store side is production-shaped; **read side unbuilt** — `RunTelemetry` exposed via no route, web diff/trace/validation pages hard-redirect to a raw spec dump. |
| **Sealant Verify / Repro / Handoff** | Prominently marketed (`apps/marketing` lines 739–753). **Zero code anywhere outside marketing.** Positioning/naming placeholders today. |
| **Issue-to-PR workflow engine** | Full DB lineage + issue import + kanban board UI exist. **Zero orchestrator** consumes `issueWorkflowExecution*`; the engine that runs the change and builds the PR is unbuilt. |
| **Managed sandbox / remote dev environment** | **The most-complete end-to-end path today**: real BuildKit compile → Zot publish → `docker run` → ssh-gateway with `direct-tcpip`→`openForward` + working editor deep-links. Limited to single-host Docker, ephemeral-only. |
| **Agent-execution control plane / fluent SDK** | **Verified mismatch** — the marketed `sandboxes.create({repository, harness}).harness.run(prompt)` does not exist; the actual contract is REST-style and needs `{ownerUserId, registryId, repository, tag, spec, sourceSelection?}` with **no `harness` field**. |

---

## 4. Hard boundaries — what Sealant is NOT (drawn from threat-model + code)

- **Tamper-EVIDENT, not tamper-PROOF.** Against the default deployment (root workload sharing the
  daemon's UID/PID/net/mount namespaces) a workload can kill the daemon, read
  `/proc/<pid>/{environ,mem}`, connect to the 0600 socket as a same-UID peer, and rewrite the spool
  + its CRC32 checksums. CRC32 is accidental-corruption detection, **explicitly not cryptographic.**
- **Not an authentication system.** The socket boundary _is_ the access boundary. `sealantd` does
  not authenticate end users; it trusts the already-authenticated caller (the SSH gateway holds
  auth). Authorization is coarse — any peer past the `0600` + `SO_PEERCRED`/uid gate is fully
  trusted. Off Linux (macOS dev) the peer check is skipped entirely.
- **Not an enforced egress boundary.** The egress proxy is cooperative (`HTTP_PROXY` honoring only).
  A workload can ignore the env, open raw sockets, or use pinned IPs and be invisible. There is
  **no allow/deny/block/rate-limit — only evidence.**
- **Not exactly-once telemetry.** At-least-once by design; dedup pushed to the SDK keyed on
  `EventId`. Worse than advertised: `high_water` advances and the spool is acked **the instant
  `broadcast.send()` is called**, regardless of whether any subscriber received it — "durable until
  first broadcast attempt," not "until SDK confirmed." No resume-from-sequence command exists.
- **Not a terminal emulator, AI model/agent, image builder, Kubernetes scheduler, SSH auth server,
  or container runtime.** It forwards raw PTY bytes without interpreting them.
- **Not multi-runtime / not persistent.** Only the Docker adapter is real; k8s/k3s throw. The Docker
  adapter refuses anything but ephemeral. **No stop/terminate/TTL/GC of running containers exists.**
- **Not a connection-resilient control channel.** Channels + event broadcast are connection-scoped:
  a dropped connection kills all PTY attaches/forwards/sftp bridges + pending requests. The TS
  client only retries the **initial** connect.
- **Not an encryption/KMS boundary.** `secret_versions` stores ciphertext + key-id + sha256 but the
  DB layer performs no crypto; runtime secrets are plaintext `-e` env to `docker run` (visible via
  `docker inspect`); redaction is heuristic/prefix-based (10 token shapes, 16-byte min).
- **Not multi-tenant at the data layer.** Ownership is per-user only — no org/team entity. The
  control-plane API has **no end-user auth middleware**; `ownerUserId` is a trusted request input.
- **Not the judge.** No confidence scores, "safe to merge," risk dashboards, or verdicts.

---

## 5. Maturity summary (real vs scaffold)

- **PRODUCTION / WORKING:** the `sealantd` daemon core (control protocol, framing, peer auth,
  process/PTY execution, signals/reaping, composition/PID-1 boot); the TS runtime SDK seed; the SSH
  gateway; the RabbitMQ worker + Postgres state model (~45 tables, lease-based at-least-once claim);
  the control-plane API (`POST /v1/sandboxes` → queued build); the telemetry ingest/store pipeline.
  **Most-complete end-to-end path:** create-blueprint → build → publish → docker-launch →
  SSH/editor access.
- **WORKING BUT PARTIAL:** telemetry durability (spool exists; ack advances on broadcast-attempt
  not receipt; `fsync` hardcoded `Never` with a 1s loss window); filesystem evidence (snapshots +
  watcher work, but no diff artifacts, no FS redaction, kill switches inert); the web console (real
  sandbox lifecycle, but Repositories/Profiles/Registry are mock; diff/trace/validation redirect).
- **SCAFFOLD / PLACEHOLDER:** privileged network modes (eBPF/netlink/payload — inert schema, no
  collector process); pidfd race-free signaling (kernel detection only, still uses `killpg`);
  k8s/k3s adapters (throw); the issue-to-PR execution engine (full DB lineage + board UI, **zero
  orchestrator**); the telemetry read-model API (no route, folds throw); Verify/Repro/Handoff (zero
  code); the mobile app (read-only live, write paths mock); the Electron app (empty scaffold).

---

## 6. The tensions the user must resolve (the grilling agenda)

1. **Narrative split.** Two product stories coexist. The rebranded marketing page (the
   doc-declared "canonical reference") sells a harness-neutral **"Runtime for AI developer agents"**
   = platform + SDK + Verify/Repro/Handoff. The in-repo README still describes **"fast isolated
   sandboxes + issue-to-PR workflows"** as the two product loops with a "sandbox + issue workflow"
   terminology contract. Marketing has quietly demoted "issue workflow" to a _product_ (Handoff).
2. **SDK overclaim (verified).** The marketing hero's fluent `sandboxes.create({harness}).harness.run()`
   → `{result, changes, artifacts, record}` does not match the real REST contract (no `harness`
   field). Either the fluent SDK ships from the external runtime-client repo and must be made
   real + public, or the hero is fiction. **The single most important platform/SDK shape decision.**
3. **Open-source / platform-location.** The footer claims "Open-source runtime," but the `.proto`
   and SDK live in an external repo. The platform the user wants to split out _already lives
   elsewhere_; `sealant-core` is the products monorepo.
4. **Execution record: captured but not consumable.** The central marketed primitive is genuinely
   captured/stored, but exposed via **no API route**, the inspector pages redirect to JSON, and the
   north-star folds throw `Unimplemented`. The platform records facts no product can yet read.
5. **Flagship loop unbuilt.** README's "issue-to-PR" and marketing's "Handoff" are the same unbuilt
   thing under two names — rich DB lineage, board UI, but no execution engine.
6. **Durability/security marketing vs code.** "Authoritative, replayable execution record" +
   "secret redaction" + "network visibility as controls" vs. tamper-evident-only, broadcast-attempt
   ack, heuristic redaction, bypassable proxy. Audit-grade framing requires a privilege boundary
   that is only a "Should"-priority, possibly-unmet requirement.
7. **Doc drift everywhere.** README understates maturity; `integration-brief.md` still says "every
   crate is a one-line stub" (false); ssh-gateway docs describe the removed inner-sshd design;
   `globals.css` header describes an old flat design contradicting its own v3 tokens; blueprint
   carries a dead `enableSealantd` flag though sealantd is now mandatory PID-1.
8. **Versioning unfinished for a platform that ships external SDKs.** Only `schema_version 1`;
   exact-match negotiation (a v2 daemon hard-rejects all v1 clients); no buf lint/breaking-change
   detection; `RequestId` documented as idempotency key but no dedup exists.

---

_Next: Stage 2 — the dev-perspective core feature list and the questions to align on._
