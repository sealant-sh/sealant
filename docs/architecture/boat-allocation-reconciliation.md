# Boat allocation and reconciliation

Boat remains unregistered and ordinary admission is unavailable. This layer connects allocation
ownership to the sealed worker exchange from #459. It does not stage launch payloads, issue resource
or tunnel permits, start the daemon, report readiness, close FINAL, recover a writer, delete disks
or park sessions.

`BoatAllocation.prepare` takes an already authorized scope, actual workspace/run identity and the
exact publication returned by the native catalog. The catalog must have an unreleased consumer pin
for that same run/runtime instance. Reservation checks the canonical ready publication and scope
under the catalog's publication/consumer locks. One transaction reserves the allocation and creates
its pending Boat runtime row. The publication catalog still owns images; the allocation owner never
invents a pin or changes the scope. The future native launch caller must invoke this after
authorized catalog acquisition. Ordinary build/launch registration stays off until isolation, tunnel
and readiness are executable.

The reservation freezes the source, launch attempt, disk lineage, idempotency key and the agent
manifest digest from the installation receipt (the one every bind request names). The allocator
checks the exact saved snapshot before atomically recording `issued`. That transition has one
winner. Only that caller may send create, using a private snapshot-enabled production allocation
with no auto-stop or provider environment. Reconciliation never sends another create for an issued
request, including beyond the provider's idempotency window. A crash between recording issuance and
sending the request can therefore leave a reservation pending indefinitely. This availability limit
is deliberate: no empty inventory proves that an earlier create cannot still appear.

A lost reply is reconciled through the existing provider client's complete paginated inventory and
all seven ownership labels. One exact positive match can be adopted. No positive evidence or an
unavailable page keeps the original obligation and pin. Multiple matches become a held record with
their exact sandbox IDs; no candidate is deleted or selected arbitrarily. A known allocation must
report snapshots enabled, monitoring disabled and auto-stop explicitly disabled. These checks do not
establish resource isolation or independently prove provider privacy.

Recording a sandbox and projecting its identity onto the pending runtime row share a transaction.
That projection may also record a late create after a stop, preserving the stop status. A stopped
issued request is still discovered so its disk cannot be forgotten; it cannot exchange or start
work. A reservation stopped before issuance never creates. The generic stranded-launch sweep skips
Boat rows because its absence/grace rules cannot settle a native allocation. Canonical publication
release refuses while an allocation obligation exists. There is deliberately no allocation reset,
replacement, deletion or release method in this layer. FINAL/recovery/parking must later supply the
canonical completion authority.

Before bootstrap, the allocator verifies provider ownership and reads the current boot UUID. It
persists the complete target before calling `BoatExecution.exchange`. Retries use that target and
the existing sealed exchange operation, and refuse a changed boot rather than silently rebinding.
Bootstrap proves authenticated held compatibility only. It is not daemon readiness or session
admission.

## Worker composition

The opt-in worker settings are `SEALANT_BOAT_API_KEY`, `SEALANT_BOAT_DEPLOYMENT_ID` and the existing
`SEALANT_CREDENTIALS_KEY`. Partial configuration refuses startup. None of these settings adds Boat
to runtime registration. With no Boat configuration, the worker starts no Boat client or reconciler.
The key is passed in memory to the existing provider client; no filesystem key discovery is added.

`boatAllocationWorkerLayer` composes the allocation repository, sealed exchange owner and real guest
transport. The application owns one managed runtime and disposes it at shutdown. A non-overlapping
30-second tick walks twenty allocation IDs at a time, with four observations in parallel and a
120-second bound per entry. The cursor advances over held, pending and failed entries. Individual
record parsing happens after pagination so malformed rows do not starve later records. At the end,
the next tick wraps to the beginning. Restarting the worker restarts this read cursor without
resetting any durable operation. No network call runs inside a database transaction.

The existing `BoatApi` owns HTTP and inventory parsing. `BoatAllocationRepo` is necessary because
neither an ephemeral job claim nor the publication catalog can own a run's issued create and atomic
runtime projection. `BoatExecution` continues to own bootstrap secrets and invocation state. The
allocation layer centralizes issuance and positive adoption so callers cannot accidentally turn an
uncertain result into a new disk.

## Validation and remaining gates

Migrated PostgreSQL and faithful loopback HTTP tests exercise lost replies, single-winner issuance,
exact snapshot and scope bindings, complete inventory adoption, pin protection, stop races, target
persistence, changed boot refusal and pagination. The worker assembly builds against local
infrastructure. These checks make no new live-provider claim.

[Worker/resource reconciliation](boat-resource-reconciliation.md) now connects the held execution to
host and guest network setup. Continue with authenticated readiness, FINAL close/exclusion and held
recovery, then executable parking. Parking will run plain `sync` before stop as hygiene. Yiannis's
2026-11-06 shipped-only hash policy, timestamp decision, own-process mapping checks, fresh clone
binding and base-matching systemd holds remain unchanged.
