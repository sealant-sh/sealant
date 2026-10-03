-- A stop records `stopped` once the executor has ended, and `removed_at` once the runtime confirmed
-- nothing of it is left (its disk, its sidecar). The exit reconciler removes the remains of a
-- `stopped` row with no removal recorded and no retention. Rows stopped before this column existed
-- are not backfilled: nothing on record proves their removal (a planned stop the reconciler
-- recorded before its removal failed left its container), so the sweep confirms each once, by the
-- runtime's idempotent removal, and records it then.
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_runtime_instances_stopped_remains_idx" ON "workspace_runtime_instances" ("finished_at") WHERE "status" = 'stopped' and "removed_at" is null;
