# Boat hosted receiver startup and failure diagnostics

Run 8's `receiver-request` step identifies a request to the hosted guest endpoint, after the Boat
`hostControl` API call succeeded. A failure of the host API itself would have step `host-receiver`
and operation `host`. The discarded response prevents attributing Run 8's HTTP 503 to the hosted
proxy, the guest relay, or the receiver. Its precise source remains unknown.

Receiver failures now retain `receiver-<route>`, the fixed `/sealant/bootstrap/<route>` path class,
HTTP status, classified transport cause, and a redacted response snippet. No origin, query, header,
or successful bootstrap reply is recorded. Failure bodies are read up to 16 KiB and cancelled; the
final UTF-8 snippet is limited to 4096 bytes. Known bearer/cookie values and request string values
(including staging files) are removed before the existing command-output redactor runs. The
diagnostic survives the adapter/worker wrappers and the runtime's stored error message.

The authenticated status GET now tolerates transient transport failures and HTTP 502/503/504. It has
a 20-second total deadline, at most 20 reads, 500 ms between failed reads, and a 5-second limit on
each request. The initial exchange passes its cancellation signal through, so the existing
120-second allocation budget still applies. Authentication refusals and invalid replies fail
immediately. No POST is retried by this transport. Status still has to pass the existing identity,
boot, empty-stage and held-admission checks before staging may start.

One authorized live launch reused publication `3db03488-f6ee-4fc0-a856-cee161b2895f` without
building or changing its snapshot. It created `bx_7g485ju9` for run
`d5f927f3-dff9-4227-bae9-0f6767df00bd`, with `sealant-dev=boat-stream` and production ownership
labels. Bind succeeded in 6.647 seconds with exit code 0. Authenticated status and staging both
passed on the first request, before the polling change was added. The receiver and relay were
active, and the receiver Unix socket existed. The HTTP 503 did not reproduce. This is evidence
through staging, not full live readiness or proof that Run 8 was a startup race.

The harness deliberately has no public resource gateway and stopped at resource preparation. Its
failing subnet allocator left an in-flight tunnel update, so canonical close remained held; that
resource-setup cleanup gap is separate from this receiver change. The authorized exact-owned API
fallback deleted the VM: operation `bdop_efcf2ad2922a45cbb1faf3beeda5ada5` completed for
`bx_7g485ju9`, followed by its exact authenticated 404. Final inventory had no sandboxes and only
the unchanged retained snapshot `sealant-dev-boat-stream-f592109285464ef19447b6a967569222`. No
second launch was made. The supplied publication JSON and its directory were deleted by their exact
paths. No VM 131 writes, Boat contact, merge, tag or release was made.

Deleted allocations retain their immutable target for audit. Resource reconciliation now reports
them closed when there is no tunnel reservation or its release is complete, rather than trying to
configure the retired guest. Unreleased tunnel cleanup remains held. Real Postgres regressions cover
both cases, including Run 7/8's no-tunnel case.

The checker accepts Core's canonical `runtime.closed` observation during FINAL cleanup, even if Mend
still reports `stopping`. The separate Mend state issue should not block that cleanup check; the
normal idle-stop flow also checks captured worktree data and is not proven by this run.

Deploy with a new Mend preview carrying this Core worker. No migration or publication rebuild is
required. The next authorized box run must still prove live readiness and capture the new safe HTTP
diagnostic if the failure recurs.
