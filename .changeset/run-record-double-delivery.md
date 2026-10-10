---
"@sealant/sdk": patch
---

An exec run no longer fails at random when its events reach the record twice at the same moment. The
run-exec job and the full-stream ingester both record a run's events, each on its own connection to
the runtime. When their inserts of the same event overlapped, the second one failed on the event's
id (`telemetry_events_pkey`), and the run failed with "Run execution failed before completion" while
its process went on and exited. The append now skips an event already stored under its id or under
its runtime and sequence, and reads it back: the same event is nothing. A different event at that id
or position (in the log, or earlier in the same batch, which used to be dropped without a word), or
a run's own event stored under another run, is a conflict: the record keeps what it has, the rest of
the batch is stored, and the append fails naming the events. The exec run then fails saying why,
with the changes its commands made. A failed job's error is recorded with bigints as strings:
pg-boss used to log "Do not know how to serialize a BigInt" instead.
