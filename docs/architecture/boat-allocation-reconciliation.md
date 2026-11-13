# Boat allocation and reconciliation

Boat remains unregistered and ordinary admission is unavailable. This layer connects allocation
ownership to the sealed worker exchange from #459. It does not stage launch payloads, issue resource
or tunnel permits, start the daemon, report readiness, close FINAL, recover a writer or delete
disks.

`BoatVm.prepare` (`src/runtime/boat/vm.ts`) takes an already authorized scope, actual workspace/run
identity and the exact publication returned by the native catalog. The catalog must have an
unreleased consumer pin for that same run/runtime instance. Reservation checks the canonical ready
publication and scope under the catalog's publication/consumer locks. One transaction reserves the
run's row in `boat_runs` and creates its pending Boat runtime row. The publication catalog still
owns images; the VM owner never invents a pin or changes the scope. The future native launch caller
must invoke this after authorized catalog acquisition. Ordinary build/launch registration stays off
until isolation, tunnel and readiness are executable.

The reservation freezes the source and its snapshot name, launch attempt, disk lineage, idempotency
key and the agent manifest digest from the installation receipt (the one every bind request names).
The launch checks the exact saved snapshot before issuing create: `create_issued_at` is written by
the database's `now()` in one guarded statement, which has one winner. Only that caller may send
create, using a private snapshot-enabled production allocation with no auto-stop or provider
environment. Only a launch issues a first create. After that a VM is found by its labels and
adopted, or create is replayed under the same key while Boat still holds it (23 hours from
`create_issued_at`, by the database's clock; an issue time in the future is refused by the table).
Past that nothing is replayed: discovery keeps looking and the run is held `create-unresolved`. No
empty inventory proves that an earlier create cannot still appear.

A lost reply is reconciled through the existing provider client's complete paginated inventory and
all seven ownership labels. One exact positive match can be adopted. No positive evidence or an
unavailable page keeps the original obligation and pin. Multiple matches become a held record with
their exact sandbox IDs; no candidate is deleted or selected arbitrarily. A known allocation must
report snapshots enabled, monitoring disabled and auto-stop explicitly disabled. These checks do not
establish resource isolation or independently prove provider privacy.

Recording a sandbox and projecting its identity onto the pending runtime row share a transaction.
That projection may also record a late create after a stop, preserving the stop status. A stopped
issued request is still discovered so its disk cannot be forgotten; it cannot exchange or start
work. A reservation stopped before issuance never creates. The publication pin of a run that has a
row is released on one thing only: Boat's committed absence on that row (`absent_at`), after its
tunnel slot is released. There is deliberately no reset, replacement or delete of a run's row.

The sweep (`BoatVm.reconcile`) resolves what a launch left unresolved and nothing more: an issued
create with no VM on record, and a run that stopped before its create. It issues no first create,
reads no boot, binds nothing and exchanges nothing. A VM its launch never bound stays unbound and is
removed on sealant's own record that nothing ran on it.

Before bootstrap, the launch verifies provider ownership and reads the current boot UUID. It
persists the complete target on the run's row before calling `BoatExecution.exchange`. Retries use
that target and the existing sealed exchange operation, and refuse a changed boot rather than
silently rebinding. Bootstrap proves authenticated held compatibility only. It is not daemon
readiness or session admission.

## Worker composition

The opt-in worker settings are `SEALANT_BOAT_API_KEY`, `SEALANT_BOAT_DEPLOYMENT_ID` and the existing
`SEALANT_CREDENTIALS_KEY`. Partial configuration refuses startup. None of these settings adds Boat
to runtime registration. With no Boat configuration, the worker starts no Boat client or reconciler.
The key is passed in memory to the existing provider client; no filesystem key discovery is added.
The API takes the same key and deployment settings (`boatProviderEnvSchema`) and builds its own
client from them, to open Boat sessions' control connections.

`boatVmWorkerLayer` composes the run repository, sealed exchange owner and real guest transport. The
application owns one managed runtime and disposes it at shutdown. A non-overlapping 30-second tick
walks twenty run IDs at a time, with four observations in parallel and a 120-second bound per entry.
It pages only the runs whose create is not resolved (`BoatRunRepo.listUnresolved`: no VM on record
and no absence committed), which is everything the sweep can change, so a run is visited within
ceil(unresolved / 20) ticks whatever the deployment's history. The cursor advances over held,
pending and failed entries. Individual record parsing happens after pagination so malformed rows do
not starve later records. At the end, the next tick wraps to the beginning. Restarting the worker
restarts this read cursor without resetting any durable operation. No network call runs inside a
database transaction.

The worker warns `Boat allocation obligations remain` for what an operator should look at: a read
that failed and a launch Boat holds more than one VM for, on every tick. Any other held run is
listed when it is first held and then once an hour, and a launch still being created is never
listed.

The existing `BoatApi` owns HTTP and inventory parsing. `BoatRunRepo` is necessary because neither
an ephemeral job claim nor the publication catalog can own a run's issued create and atomic runtime
projection. `BoatExecution` continues to own the bind exchange's sealed bearer and the launch's
state, on the same row. `BoatVm` centralizes issuance and positive adoption so callers cannot
accidentally turn an uncertain result into a new disk.

At start the worker opens every live run's sealed bearer once and logs, by run, any that does not
open: such a session cannot be drained. It reads the database only and never stops the worker.

## Validation and remaining gates

Migrated PostgreSQL and faithful loopback HTTP tests exercise lost replies, single-winner issuance,
exact snapshot and scope bindings, complete inventory adoption, pin protection, stop races, target
persistence, changed boot refusal and pagination. The worker assembly builds against local
infrastructure. These checks make no new live-provider claim.

The orders the tests do not pin are model-checked: a TLA+ model of the run's row, the launch, the
sweeps, the removal and Boat (`docs/verification/boat-custody/`, run by the `boat-custody` skill)
checks that no absence is committed while Boat may hold a VM for the run. Its record lists the
schedules where main can still break that, and the assumptions it makes about Boat.

[Worker/resource reconciliation](boat-resource-reconciliation.md) now connects the held execution to
host and guest network setup. Continue with authenticated readiness, then FINAL close/exclusion and
held recovery. Snapshot parking was cut: a stopped session is drained and deleted, and resuming is a
fresh VM from the project snapshot plus the captured worktree. Yiannis's 2026-11-06 shipped-only
hash policy, timestamp decision, own-process mapping checks, fresh clone binding and base-matching
systemd holds remain unchanged.
