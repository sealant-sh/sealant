# Boat failed-build recovery

A failed first native build used to quarantine the exact recipe key permanently. Every later session
received the same refusal, even after a transient provider failure was fixed.

A new session can now spend one replacement build for an unpublished reservation with a known
construction-failure reason. The database transaction marks the original reservation `superseded`
and inserts a new reservation with a new publication ID, build ID, `buildAttempt: 2` and
`replacesPublicationId`. The original reason, identity and consumer bindings remain intact. A
transaction-scoped recipe lock and the unique active-key/predecessor indexes serialize concurrent
acquires. A redelivered session keeps its original binding and cannot spend the replacement.

The limit is two builds per reservation lineage, including the original. If the replacement also
fails, a new acquire returns `publication-build-attempts-exhausted` and the recorded cause. It makes
no provider request. The worker records failed build-job and runtime rows with that code and
message. Only `publication-pending` is polled. A genuinely changed environment has a different
recipe key; repeated clicks on the same failed recipe cannot start more builds.

Eligible reasons are `native-provider-transport_error`, `native-provider-provider_error`,
`native-guest-command-failed`, `native-sandbox-failed`, `native-save-failed` and
`native-interrupted`. The builder returns these construction failures only after its existing
cleanup completes, or before it owns a VM. `native-cleanup-pending`, missing journals, ownership or
evidence disagreements, unknown reasons and ready-publication integrity quarantine remain closed. A
publication with any saved artifact is never replaced by this path.

The migration gives existing reservations attempt one and no predecessor. Run 4's unpublished
`34aa66fd` with `native-provider-transport_error` is eligible on a new session acquire, without a
manual database reset. Its old session and job remain failed. No VM 131 access or writes were used.
A new Mend preview must bundle the changed sealant worker and apply
`20261108191021_boat_failed_build_replacement` before session 5.

Real Postgres and HTTP tests cover the original failure, immutable redelivery, one fresh build,
concurrent acquires sharing the replacement, successful publication after a run-4-style failure,
attempt exhaustion without another create, integrity/cleanup refusals, and the real worker's
terminal failed rows and recorded cause. The regression failed on the original permanent quarantine
behavior before implementation.

The separately authorized detached build passed through a saved publication, with exact deletion and
empty final inventories. It proves the native mechanism. The bounded recovery path itself is proven
with real Postgres and HTTP locally. See [transport acceptance](boat-long-command-transport.md) for
the install duration, poll count and receipts.
