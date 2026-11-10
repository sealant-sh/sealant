# Boat bind failure and pre-invocation close

The Run-7 failure was reproduced with one launch against ready publication
`3db03488-f6ee-4fc0-a856-cee161b2895f`. No native build or publication change was made.

The provider command completed in 1.272 seconds with exit code 1, no timeout and empty stdout. Its
redacted stderr was:

```text
Traceback (most recent call last):
  File "/var/lib/sealant/guest/guest_boot.py", line 723, in <module>
    main()
  File "/var/lib/sealant/guest/guest_boot.py", line 691, in main
    raise ValueError('outer-owner-required')
ValueError: outer-owner-required
```

The public bind command omitted `sudo`. Boat executes it as its default user, but bootstrap requires
root in the outer user namespace. Construction already invokes privileged helpers through sudo. The
fix prefixes bind and snapshot-resume commands with `/usr/bin/sudo -n --`. It changes Core's command
wrapper, so the existing publication can be reused without rebuilding its snapshot. The local Docker
regression runs the real bundled Python and guest code as a non-root default user. The old command
hits the owner refusal; the fixed command reaches request validation past that gate. This is not
live readiness acceptance after the fix. No second launch was run.

The reproduction created only `bx_ebvepd9p`, with `sealant-dev=boat-stream` and exact run labels.
The new canonical close path fenced its exchange, requested deletion, then confirmed its exact 404
and released the publication pin. Final inventories contained no sandboxes and only the retained
snapshot `sealant-dev-boat-stream-f592109285464ef19447b6a967569222`. The supplied publication file
and its directory were deleted by their exact paths.

Bound guests can now close before invocation issuance. A terminal `aborted` execution row prevents
reservation, exchange completion, staging and invocation issuance from racing with cleanup. An
absent execution gets a tombstone; existing exchange/control/prepared/installed records use CAS. The
allocation keeps its immutable target and records deletion issuance and positive completion or exact
absence. Existing tunnel setup is frozen; its slot and the publication pin release only after
positive VM deletion and host cleanup. Issued or running invocations still require capture recovery
and canonical FINAL evidence.

The stopped Run-7 allocation `314ba22c` will be settled by the close reconciler from its recorded
sandbox ID and the provider's exact 404. No database reset is needed. Deleted allocations now report
`deleted`, so the allocation obligations log no longer calls them held.

Validation includes disposable-Postgres races and cleanup, failure-tail redaction and persistence
through the real worker, the full worker/publication/readiness/shell/FINAL/fresh-resume test, and
the non-root bootstrap regression in CI. Failure tails are limited to 4096 UTF-8 bytes per stream
and use the native-build redactor. Successful bootstrap output is not logged.

Deployment requires a new Mend preview with this Core worker pin. No migration is required; the new
states are in the existing versioned JSON records and old rows continue to parse. No VM 131 writes,
Boat contact, merge, tag or release was made.
