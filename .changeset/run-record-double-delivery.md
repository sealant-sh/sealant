---
"@sealant/sdk": patch
---

An exec run no longer fails at random when its events reach the record twice at the same moment. The
run-exec job and the full-stream ingester both record a run's events, each on its own connection to
the runtime. When their inserts of the same event overlapped, the second one failed on the event's
id (`telemetry_events_pkey`), and the run failed with "Run execution failed before completion" while
its process went on and exited. The append now skips an event already stored under its id or under
its runtime and sequence. A re-delivered event that differs from the stored one, or a run's own
event stored under another run, is kept as stored, recorded as a `dropped_event` loss span on the
run it was for, and never counted as recorded. The job appends each batch once and never waits on
the store; when the process has exited it checks the log for what the store refused, and only events
not in it (the ingester stores the same ones) fail the run, after its exit code and changes are
recorded. A failed job's error is recorded with bigints as strings: pg-boss used to log "Do not know
how to serialize a BigInt" instead.
