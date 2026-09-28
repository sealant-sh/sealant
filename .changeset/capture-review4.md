---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A completion attestation carries the seal's time, and a newer observation that the work is not saved
revokes an older seal.

- `stop({ completion: { sealedAt } })` (`StopWorkspaceRequest.completion.sealedAt`, ISO 8601,
  optional): when the store recorded the seal. The control plane weighs the attestation against its
  own observations of the executor, when it is accepted and again whenever it is used: an older
  epoch, a capture past `captureN`, or — in the same epoch — a report that the work is not saved
  (incomplete, changed, unreadable, a failed snapshot) that did not come before the seal (its head
  short of `captureN`, or read more than 60 s before `sealedAt`) makes it `ignored`. Without
  `sealedAt`, any such report at or past `captureN` does. A seal stands in for a lost FINAL answer,
  never for a received one that said the work is not saved. An unparseable `sealedAt` is ignored.
- `captureDrain().completion.sealedAt` reports it back.

Server-side (the packages ride the release train): recorded evidence (an earlier complete flush, an
attestation) removes only an executor that ended; a running one is drained (FINAL) first, the
retained-executor recovery included. A kept executor's retention and its terminal write commit in
one transaction, and every sweep looks again at an ended capture executor nothing settled. A launch
still pending when its runtime's preservation start arrives is taken from its worker and drained,
and a launch never waits for readiness past that start (`WORKSPACE_CAPTURE_DEADLINE_LEAD_MS`). The
MicroVM agent spares, in a recovery and in the list it hands sealantd (`SEALANT_SWEEP_EXEMPT_FILE`),
only the processes it started itself, by pid and start time — never by name — and stops the guest
Docker service before a recovery boot. Migration `capture_attestation_freshness`.

Also server-side: every capture executor boots with `SEALANT_CAPTURE_LAUNCH_ID` when the create
named a launch; `store-fidelity` is never saved; a FINAL whose connection closes under it (its sweep
stops the relay) is read again rather than reported as refused, in the flush route and in every
drain; a Docker recovery starts the workspace's parked Docker sidecar first; and an executor whose
recovery boot finds nothing to save (sealantd exit 76: it never materialized) is released with the
daemon's words recorded.
