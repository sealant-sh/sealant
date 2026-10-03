-- A stop records `stopped` once the executor has ended, and `removed_at` once the runtime confirmed
-- nothing of it is left (its disk, its sidecar). The exit reconciler removes the remains of a
-- `stopped` row with no removal recorded and no retention. Every row stopped before this column
-- existed was removed by its stop in one call: recorded from its end — except where a retention
-- says its disk is still kept.
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_runtime_instances_stopped_remains_idx" ON "workspace_runtime_instances" ("finished_at") WHERE "status" = 'stopped' and "removed_at" is null;--> statement-breakpoint
UPDATE "workspace_runtime_instances" i
SET "removed_at" = coalesce(i."finished_at", i."updated_at")
WHERE i."status" = 'stopped'
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_capture_drains" d
    WHERE d."run_id" = i."run_id" AND d."retained_at" IS NOT NULL
  );
