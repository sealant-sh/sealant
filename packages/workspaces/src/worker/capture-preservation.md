# Automatic Boat parking

The canonical capture ledger now executes parking and resume. A retained, idle capture session keeps
its original VM during a frozen retention delay, then closes the workspace on it (the guest agent's
park), transfers custody to a named personal saved snapshot of that VM's disk and positively deletes
the VM. Resume allocates a fresh child from the snapshot, binds it on its new boot, and pushes a
launch that starts the pinned daemon on the kept disk against its original capture staging. It
preserves unsent work and does not replay setup, startup, dotfiles or the original harness.

Boat remains unregistered. Ordinary admission stays off. These local proofs do not satisfy the
required live preview proof of readiness, automatic parking, positive deletion and resume.

## Scheduling

The worker sweeps every 30 seconds. It enrolls retained original allocations in rotating batches of
100 and claims at most ten due roots. One broken enrollment cannot occupy the entire due queue. The
existing capture stop/exit path records retention; this does not infer user inactivity from network
traffic or park an actively used workspace.

`SEALANT_BOAT_AUTOMATIC_PARKING` defaults to true. False prevents new close intents and new
enrollments while issued operations keep reconciling: an enrolled source leaves custody only by
being parked, so a retained session that is not enrolled stays with the lifecycle sweep, which
retries its FINAL. `SEALANT_BOAT_PARKING_DELAY_SECONDS` defaults to 3600 and accepts 300
through 604800. The first episode freezes its policy. A resumed incarnation gets a new delay under
that same policy when it is retained again. API stop addresses canonical custody before the legacy
stopped-workspace no-op. The legacy recovery sweep excludes enrolled roots and every Boat run. An
enrollment that fails is logged once per distinct cause and retried on the next sweep.

## Custody transfer

An authenticated FINAL observation must settle before a close can issue. An unanswered or active
FINAL remains a fence. The close is the guest agent's park (`POST /sealant/park`, one operation id,
`docs/architecture/boat-guest-agent.md`): from its first attempt no launch or recovery is accepted
on that boot. It kills sealantd's PID namespace (the daemon and every process it started die with
their init), stops the guest Docker service and proves nothing of Docker still runs (its engine's
and containers' cgroups are emptied, else no receipt and a retryable refusal), runs `sync`, and
writes the receipt the saved snapshot must carry. The same operation again answers the same receipt.
The earlier durability investigation found no user-work loss that `sync` needs to fix.

The saved snapshot is the VM's disk as the park left it; Core exports no capsule of its own. What
the custody ledger records of it is the park receipt (its path, SHA-256 and size), and the saved
snapshot is verified to hold exactly that file before the source VM is deleted.

The worker records a unique save intent before sending it once. It verifies the personal-wallet
inventory, the exact ready artifact identity, and the bounded raw capsule file stream by immutable
snapshot ID, length and SHA-256. Only then does it revoke resources and issue source deletion. Only
the exact completed provider deletion operation ends compute custody. Gateway cleanup is rechecked
before the tunnel reservation is released, including after a worker restart.

Lost save and create replies observe the original intent. A 404 never permits a replacement. A lost
deletion reply without an operation ID remains owned and unresolved. Snapshot retirement requires an
acknowledged exact deletion, so absence alone does not release an artifact or pin.

## Resume and current identity

A recovery intent reserves the child runtime, guest binding, allocation key and artifact consumer.
The child must be hydrated with automatic stop disabled. The disk was parked on its last boot, so
the bind exchange on the child's new boot binds it once more, as this new instance of the same
deployment; the binding receipt is the rebind's durable identity. Admission stays held. The worker
then establishes fresh exchange keys, isolation, tunnel, launch ownership and authenticated
readiness.

The launch retains its capture launch ID and worktree ID. It preserves the original sealed inputs
until canonical terminal release. The worker waits at least 31 seconds after positive writer
closure, matching Mend's current 30-second capture lease, and requires a strictly newer capture
epoch before promotion. A changed lease contract or stale epoch refuses. Local daemon evidence
advances a fixture epoch; it does not exercise the real Mend lease service.

Promotion moves one canonical current pointer. Historical runtime rows remain unchanged. Resource
reconciliation, readiness, workspace reads, stop, credentials and interactive lookup resolve the
current child. A parked session exposes no removed source as an interactive runtime. Boat's general
API/SSH transport remains unavailable while admission is off.

Complete authenticated FINAL or owner discard can discharge the lineage only after all known VMs are
positively removed, tunnel slots are released and non-retirement effects are settled. The canonical
owner then releases artifact consumers, retires every saved ancestor, releases the publication pin
and clears retained resume envelopes. Unresolved descendants prevent release. A discard racing an
issued child create remains held until that obligation is reconciled; it cannot justify deleting the
source artifact or starting another child.

## Provider and live limits

The adapter selects `org=personal` for inventory and save. The allowance is an observed aggregate,
with included, used and extra counts and a database timestamp. It never assigns a particular
snapshot a free slot. The selected account is scoped by deployment configuration, not an
independently measured provider account ID. Public privacy remains `unknown`; wallet membership is
not independent proof of private visibility. Personal scope, privacy, immutable-file access and
hydration must be confirmed in the live proof before admission.

This layer introduces no Boat calls during local verification. The PostgreSQL/HTTP fixture proves
durable ordering, lost replies, stale claims, repeated parking and descendant retirement. It does
not prove Boat's deletion or snapshot semantics. The agent's tests (`agent-boat.test.ts`) prove the
park closes the boot, kills the daemon's namespace, proves Docker stopped and writes one receipt per
operation. The real pinned daemon proof (`parking-daemon.e2e.ts`) proves staging transfer and
unchanged unsent bytes on copied disk with no hook replay. These proofs are deliberately separate
from a provider end-to-end claim.

## Reproduction

Apply migrations to an owned PostgreSQL 17 database before testing. With its URL in
`SEALANT_TEST_DATABASE_URL`, run:

```sh
pnpm --filter @sealant/workspaces exec vitest run \
  src/runtime/boat/allocation.db.test.ts src/runtime/boat/execution.db.test.ts \
  src/runtime/boat/api.test.ts src/worker/capture-preservation.db.test.ts \
  src/worker/capture-drain-ledger.db.test.ts src/runtime/boat/agent-boat.test.ts
```

The Docker CI job runs the real encrypted network proof and the pinned daemon's parking proof
without skips. `parking-daemon.e2e.ts` requires the exact pinned `SEALANTD_BIN` or
`SEALANT_BOAT_RUNTIME_BUNDLE`. `assets.test.ts` exercises packaging with the latter variable set,
including a checker run with source files unavailable. CI also runs forced typecheck and lint
through the standard monorepo tasks.
