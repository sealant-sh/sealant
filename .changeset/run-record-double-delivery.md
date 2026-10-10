---
"@sealant/sdk": patch
---

An exec run no longer fails at random when its events reach the record twice at the same moment. The
run-exec job and the full-stream ingester both record a run's events, each on its own connection to
the runtime. When their inserts of the same event overlapped, the second one failed on the event's
id (`telemetry_events_pkey`), and the run failed with "Run execution failed before completion" while
its process went on and exited. The append now skips an event already stored under its id or under
its runtime and sequence. A re-delivered event that differs from the stored one is logged as an
error and the stored one is kept. A batch the store refuses is retried, held back while the process
runs, and appended again once it exits: only events still not stored then fail the run, with the
exit code and changes it recorded and a `dropped_event` loss span. A failed job's error is recorded
with bigints as strings: pg-boss used to log "Do not know how to serialize a BigInt" instead.
