# Boat provider lifetime and ownership evidence

This provider stage starts at Core `8c22bfc4a06ff03a7b764ae75de2d954a2dbec52`. Boat remains
unregistered. No executor, admission, tunnel, database, SDK, or worker registration behavior is
added.

Running retention was decided by the orchestrator overnight under Yiannis's overnight carry-on
authority. Yiannis is to confirm in the morning and has not seen or accepted that decision yet. The
selected policy keeps a VM running when FINAL cannot be saved, until recovery or explicit discard.
This stage establishes the provider contract needed by that policy.

## Recorded live proof

The [redacted evidence](./boat-provider-lifetime-evidence.json) records a single small VM on
2026-11-05, from `05:34:32.346Z` to `05:34:50.815Z`. Both create and resume returned HTTP 202. The
proof requested `ttlSeconds: null`, `noEnv: true`, `monitoring: false`, `snapshots: true`, and
`type: "small"`. It sent no guest environment or setup script.

The VM was `bx_tpua7qtx`. Its fresh proof UUID was `d2336a5a-641c-4d93-aae9-2f975b32354a`. Create
and resumed live observations reported `idle`, `archiveAfter: null`, `ttlSeconds: null`,
`snapshots: true`, and `monitoring: false`. The account retention read reported `enabled: false`,
`snapshotsOff: false`, and `monitoringOff: false`. The proof never changed the account policy or
billing.

One intentional stop reached `archived`, followed by one resume of the same sandbox ID. This was a
warm stop/resume. It does not establish cold restoration, writer exclusion, FINAL capture, or
indefinite uptime. Provider failures and exhausted account balance remain outside Core's control.

Deletion operation `bdop_e54bd3d20fb147b0aa54f220ed741750` reached `completed` at `05:34:50.684Z`.
Final inventory at `05:34:50.815Z` contained zero sandboxes across one complete cursor page and zero
saved snapshots in the documented complete saved-snapshot response. Both owned inventories were
empty. No owned resource or cleanup obligation remains from this proof.

## Rerun the bounded proof

Read the current Boat documentation before running the
[proof helper](./boat-provider-null-ttl-proof.mjs). It makes a paid allocation. Run only one proof
at a time, with at most one small VM. The helper writes a new private ledger, records the owned ID
synchronously, and performs exact-ID cleanup in `finally`, including after interruption. It limits
the main proof to six minutes and cleanup to three minutes. Inspect its final inventories before
discarding the ledger.

From the repository root:

```sh
boat_provider_proof_dir="$(mktemp -d -t boat-provider-stage1.XXXXXX)"
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" \
  node docs/experiments/boat-provider-null-ttl-proof.mjs \
  "$boat_provider_proof_dir/evidence.jsonl"
```

The key exists only in the local command environment and the client's memory. The helper sends it
only as the provider authorization header. It validates allowlisted observations before logging and
never logs raw response bodies or errors. No account credential enters guest `env` or `setupScript`.

A missing create response stays unresolved. Preserve the ledger and reconcile its exact identity
with complete inventory. Do not reissue an expired idempotency key or create a replacement to find
the original. An unresolved deletion requires its recorded exact operation and final inventories.
Never delete unrelated objects. To remove a completed local proof directory, first list that exact
created directory, then remove only that exact path.

The recorded live run used a standalone scratch runner before provider implementation. The evidence
includes that runner's SHA-256. The committed helper keeps the same wire requests and adds stricter
observation validation, synchronous ledger writes, interruption handling, and cleanup when initial
inventory is unavailable. Those helper changes were syntax checked without allocating another VM.

## Provider contracts

`BoatCreateInput` requires an explicit lifetime. Production sessions require a parsed, immutable
`BoatOwnership`. Their create and resume bodies send exact null TTL. Bounded callers retain the
900-second default and the local 60-to-1800-second limit. The builder explicitly retains its
900-second TTL. Both choices request small isolated VMs with snapshots enabled and monitoring off.

Create returns the allocated ID even when valid response evidence cannot verify disabled auto-stop.
`BoatSandbox.autoStop.kind` is `disabled` only with explicit `archiveAfter: null` and no
contradictory numeric TTL. A missing deadline or contradictory fields produce `unverified`. An
observed deadline produces `scheduled`. Production admission must require `disabled` and inspect
snapshot retention, expiry, and pending stop observations. A successful allocation is not a
production readiness verdict. Resume reads the exact sandbox after acceptance, so its result
contains a fresh observation rather than inferred liveness. `idle` stays a live provider state.
Observation and discovery issue no automatic stop, delete, parking, or lifetime updates.

`BoatOwnership` validates deployment, workspace, run, runtime instance, launch attempt, and exact
source identity. Each value is nonempty, has no control characters, and fits Boat's 256-byte label
limit. Create writes seven labels, including `sealant-runtime=boat`, within the 20-label limit.
Production allocation does not use development labels. Build and proof callers keep their existing
markers.

`discover(ownership)` uses repeated exact `label=key=value` filters, follows every cursor page, and
checks every label locally. It deduplicates repeated observations of the same provider ID. One exact
match returns `found`, multiple exact provider IDs return `conflict`, and a complete list without a
match returns `unknown` with `no-positive-evidence`. Invalid or unavailable pages and repeated
cursors return `unknown` with a redacted error. Partial matches never become a complete owned
result.

All provider knowledge stays in the existing `api.ts` and `config.ts` owners. No additional service
or policy wrapper was necessary. These signatures refine the accepted sketches at the provider
boundary. They do not implement the durable executor's `LocateResult` or lifecycle transitions.

## Local checks and remaining gates

The HTTP boundary tests exercise exact create and resume requests, missing and contradictory
lifetime evidence, safe refusals, idle observations, all ownership labels, opaque cursors, complete
pagination, malformed pages, repeated cursors, unavailable later pages, no matches, duplicate exact
matches, and lost-create uncertainty. Existing builder tests check bounded allocation and stable
retry bodies. The local builder HTTP suite uses the existing verified runtime bytes and allocates no
VM.

The durable executor still needs issued-create slot occupancy, original-key retries only within the
documented 24-hour guarantee, positive adoption, conflict quarantine, and no reissue after
uncertainty. Full failed-FINAL retention, idle maintenance, claim takeover, controller outage,
recovery, and deletion authorization remain integration gates. Public Core and SDK serialization
must still retain the exact VM ID, observed running state, and continuing compute cost. The parent
owns those changes, the full forced monorepo checks, registration, and publication. No full
running-retention integration pass is claimed here.

Sources read on 2026-11-05:

- [Create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox.md), including labels,
  snapshots, and the 24-hour idempotency guarantee.
- [Resume](https://docs.boat.dev/api/reference/sandboxes/resume-sandbox.md) and
  [auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop.md).
- [List](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes.md), including exact repeated
  filters and `pageInfo`.
- [Stop](https://docs.boat.dev/snapshots/stop.md) and
  [stop API](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox.md).
- [Account retention](https://docs.boat.dev/api/reference/account/get-account-data-retention-policy.md),
  read only.
- [Delete](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data.md),
  [deletion operations](https://docs.boat.dev/api/reference/account/get-deletion-operation.md), and
  [saved-snapshot inventory](https://docs.boat.dev/api/reference/snapshots/list-saved-snapshots.md).
