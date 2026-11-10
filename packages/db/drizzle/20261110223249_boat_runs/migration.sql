-- One row per Boat run. `boat_allocations`, `boat_executions` and `boat_observations` are replaced
-- by `boat_runs`: every fact the three held about a run is one column of its one row, written by
-- one guarded statement. This migration moves where the facts live and changes nothing Core does.
--
-- It is forward only. The three old tables are kept, frozen, for one release: a trigger on each
-- raises on any INSERT, UPDATE or DELETE, so a worker that predates this migration fails closed
-- (it launches nothing and deletes nothing, and every VM is kept until it is upgraded). They are
-- dropped by a later migration. Nothing is written to both.
--
-- (1) Refuse what cannot be carried. Each of these is a state Core never writes; a database that
-- has one is not upgraded until it is looked at.
DO $$
DECLARE
  found bigint;
BEGIN
  -- #561: every lookup by run id depends on the two being equal, and nothing enforced it.
  SELECT count(*) INTO found FROM "boat_executions" WHERE "runtime_instance_id" <> "run_id";
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_executions has % row(s) whose runtime_instance_id is not their run_id; boat_runs has one row per run and cannot carry them.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO found FROM "boat_allocations" a
    WHERE a."record"->>'phase' IS NULL
       OR a."record"->>'phase' NOT IN ('reserved','issued','allocated','bound','held','deleting','deleted');
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_allocations has % row(s) in a phase this migration does not know.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO found FROM "boat_executions" e
    WHERE e."record"->>'phase' IS NULL
       OR e."record"->>'phase' NOT IN ('exchange','control','installed','issued','running','held','aborted');
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_executions has % row(s) in a phase this migration does not know.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- A sealed bearer opens only under the target it was sealed with, and that target becomes the
  -- run's: an execution with no allocation, or bound to another target, has no row to live on.
  SELECT count(*) INTO found FROM "boat_executions" e
    LEFT JOIN "boat_allocations" a ON a."runtime_instance_id" = e."runtime_instance_id"
    WHERE a."runtime_instance_id" IS NULL
       OR a."record"->'target' IS DISTINCT FROM e."record"->'target';
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_executions has % row(s) with no allocation, or whose target is not their allocation''s target.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO found FROM "boat_observations" o
    LEFT JOIN "boat_allocations" a ON a."runtime_instance_id" = o."runtime_instance_id"
    WHERE a."runtime_instance_id" IS NULL
       OR (o."presence" = 'absent' AND o."sandbox_id" IS DISTINCT FROM a."sandbox_id");
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_observations has % row(s) with no allocation, or recording the absence of a VM that is not their allocation''s.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An allocation ended on Boat''s 404 is written only under a committed absence.
  SELECT count(*) INTO found FROM "boat_allocations" a
    LEFT JOIN "boat_observations" o ON o."runtime_instance_id" = a."runtime_instance_id"
    WHERE a."record"->>'phase' = 'deleted'
      AND a."record"->'removal'->>'kind' = 'absent'
      AND o."presence" IS DISTINCT FROM 'absent';
  IF found > 0 THEN
    RAISE EXCEPTION 'boat_allocations has % row(s) ended on Boat''s absence with no absence observed.', found
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;
--> statement-breakpoint
-- (2) Nothing writes a run while it is carried.
LOCK TABLE "boat_allocations", "boat_executions", "boat_observations", "boat_tunnels" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- (3) The table.
CREATE TABLE "boat_runs" (
	"run_id" text PRIMARY KEY,
	"deployment_id" text NOT NULL,
	"publication_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"launch_attempt_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"snapshot_name" text NOT NULL,
	"resources" text,
	"idempotency_key" uuid NOT NULL UNIQUE,
	"disk_lineage" uuid NOT NULL UNIQUE,
	"create_issued_at" timestamp with time zone,
	"sandbox_id" text,
	"created_seen_at" timestamp with time zone,
	"target" jsonb,
	"exchange_id" uuid,
	"exchange_public_key" text,
	"sealed_exchange" text,
	"sealed_control" text,
	"admission_operation_id" uuid,
	"admission_epoch" integer,
	"admission_digest" text,
	"docker" boolean,
	"sealed_launch" text,
	"isolation" jsonb,
	"launch_issued_at" timestamp with time zone,
	"launch_accepted_at" timestamp with time zone,
	"fenced_at" timestamp with time zone,
	"deletion_claimed_at" timestamp with time zone,
	"deletion_operation_id" text,
	"deletion_completed_at" timestamp with time zone,
	"absent_at" timestamp with time zone,
	"absent_basis" text,
	"held_reason" text,
	"conflicting_sandboxes" jsonb DEFAULT '[]' NOT NULL,
	CONSTRAINT "boat_runs_resources" CHECK ("resources" is null or "resources" = 'none'),
	CONSTRAINT "boat_runs_target" CHECK ("target" is null or ("sandbox_id" is not null and "target"->>'runId' = "run_id" and "target"->>'runtimeInstanceId' = "run_id" and "target"->>'deploymentId' = "deployment_id" and "target"->>'workspaceId' = "workspace_id" and "target"->>'launchAttemptId' = "launch_attempt_id" and "target"->>'sourceId' = "publication_id"::text and "target"->>'sandboxId' = "sandbox_id" and "target"->>'diskLineage' = "disk_lineage"::text and "target"->>'manifestDigest' = "manifest_digest")),
	CONSTRAINT "boat_runs_vm" CHECK (("sandbox_id" is null or "create_issued_at" is not null) and ("sandbox_id" is not null or ("created_seen_at" is null and "deletion_claimed_at" is null and "deletion_operation_id" is null)) and ("deletion_completed_at" is null or ("deletion_operation_id" is not null and "absent_at" is not null))),
	CONSTRAINT "boat_runs_launch" CHECK (("exchange_id" is null or "target" is not null) and ("sealed_exchange" is null or ("exchange_id" is not null and "exchange_public_key" is not null)) and ("sealed_control" is null or ("exchange_id" is not null and "sealed_exchange" is null)) and num_nulls("admission_operation_id", "admission_epoch", "admission_digest", "docker") in (0, 4) and ("admission_operation_id" is null or "exchange_id" is not null) and (("sealed_launch" is null and "isolation" is null) or "admission_operation_id" is not null) and ("launch_issued_at" is null or "admission_operation_id" is not null) and ("launch_accepted_at" is null or "launch_issued_at" is not null)),
	CONSTRAINT "boat_runs_absence" CHECK (("absent_at" is null and "absent_basis" is null)
        or ("absent_at" is not null and "absent_basis" = 'not-found' and "sandbox_id" is not null and "created_seen_at" is not null)
        or ("absent_at" is not null and "absent_basis" = 'deletion-completed' and "sandbox_id" is not null)
        or ("absent_at" is not null and "absent_basis" = 'never-created' and "sandbox_id" is null)),
	CONSTRAINT "boat_runs_held" CHECK ("held_reason" is null or ("absent_at" is null and "target" is null and "held_reason" in ('allocation-conflict', 'lifetime-unverified', 'run-stopped', 'create-unresolved') and ("held_reason" = 'lifetime-unverified') = ("sandbox_id" is not null) and ("held_reason" = 'run-stopped') = ("create_issued_at" is null)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "boat_runs_sandbox" ON "boat_runs" ("deployment_id","sandbox_id");--> statement-breakpoint
CREATE INDEX "boat_runs_deployment" ON "boat_runs" ("deployment_id","run_id");--> statement-breakpoint
ALTER TABLE "boat_runs" ADD CONSTRAINT "boat_runs_run_id_workspace_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "boat_runs" ADD CONSTRAINT "boat_runs_publication_id_native_publications_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "native_publications"("id") ON DELETE RESTRICT;
--> statement-breakpoint
-- (4) Create is replayed under its idempotency key only while Boat still holds the key, measured
-- from `create_issued_at`. It is written by `now()` in the statement that issues create; an issue
-- time in the future would make every replay look fresh, so it is refused whoever writes it.
CREATE FUNCTION boat_runs_issue_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."create_issued_at" IS NOT NULL AND NEW."create_issued_at" > now() THEN
    RAISE EXCEPTION 'boat_runs.create_issued_at of run % is in the future (%); create is issued at now().', NEW."run_id", NEW."create_issued_at"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "boat_runs_issue_time" BEFORE INSERT OR UPDATE OF "create_issued_at" ON "boat_runs"
  FOR EACH ROW EXECUTE FUNCTION boat_runs_issue_time();
--> statement-breakpoint
-- (5) Carry every run. The allocation gives the VM's columns, the execution the launch's, the
-- observation what Boat said. `target`, `exchange_id` and every sealed value are copied as they
-- are: a secret opens only under `{target, exchangeId, purpose}`, so nothing is rebuilt.
--
-- The old records kept no instant for a launch push, its acknowledgement or a fence: those are
-- carried as the migration's own time. A launch whose push was issued (`issued`, `running`,
-- `held`) is carried with `launch_issued_at` set, whatever became of it: nothing whose push was
-- issued is carried as never launched.
INSERT INTO "boat_runs" (
  "run_id", "deployment_id", "publication_id", "workspace_id", "launch_attempt_id",
  "manifest_digest", "snapshot_name", "resources", "idempotency_key", "disk_lineage",
  "create_issued_at", "sandbox_id", "created_seen_at", "target",
  "exchange_id", "exchange_public_key", "sealed_exchange", "sealed_control",
  "admission_operation_id", "admission_epoch", "admission_digest", "docker", "sealed_launch",
  "isolation", "launch_issued_at", "launch_accepted_at", "fenced_at",
  "deletion_claimed_at", "deletion_operation_id", "deletion_completed_at",
  "absent_at", "absent_basis", "held_reason", "conflicting_sandboxes"
)
SELECT
  a."runtime_instance_id",
  a."deployment_id",
  a."publication_id",
  a."record"->'input'->>'workspaceId',
  a."record"->'input'->>'launchAttemptId',
  a."record"->>'manifestDigest',
  a."record"->'input'->'publication'->'snapshot'->'identity'->>'name',
  a."record"->'input'->>'resources',
  a."idempotency_key",
  a."disk_lineage",
  -- Never issued: still reserved, stopped before create, or ended with no VM and no issue time.
  -- A record issued before issue times were kept, or carrying one in the future, takes its
  -- reservation's time, which is never later than its create.
  CASE
    WHEN v.phase = 'reserved' THEN NULL
    WHEN v.phase = 'held' AND a."record"->>'reason' = 'run-stopped' THEN NULL
    WHEN v.phase = 'deleted' AND v.removal_kind = 'never-created' AND v.issued_at IS NULL THEN NULL
    ELSE least(CASE WHEN v.issued_at IS NULL OR v.issued_at > now() THEN a."created_at" ELSE v.issued_at END, now())
  END,
  a."sandbox_id",
  CASE WHEN o."sandbox_id" = a."sandbox_id" THEN o."created_observed_at" END,
  NULLIF(a."record"->'target', 'null'::jsonb),
  (e."record"->>'exchangeId')::uuid,
  NULLIF(e."record"->>'publicKey', ''),
  CASE WHEN v.absent_basis IS NULL THEN e."record"->>'sealedExchange' END,
  e."record"->>'sealedControl',
  (v.admission->>'operationId')::uuid,
  (v.admission->>'epoch')::integer,
  v.admission->>'digest',
  CASE WHEN v.admission IS NOT NULL THEN coalesce((v.admission->>'docker')::boolean, false) END,
  -- One sealed copy of the launch material: the one kept for the launch's whole life where the
  -- record has it, else the one not yet pushed. A VM Boat no longer has needs none: it is erased
  -- with the absence, as the statement that records an absence erases it from now on.
  CASE WHEN v.absent_basis IS NULL THEN coalesce(v.admission->>'sealedResumeEnvelope', v.admission->>'sealedEnvelope') END,
  NULLIF(e."record"->'isolation', 'null'::jsonb),
  CASE WHEN v.launch IN ('issued', 'running', 'held') THEN now() END,
  CASE WHEN v.launch = 'running' THEN now() END,
  -- Fenced: a held or aborted execution, and a VM never bound whose deletion was already claimed.
  CASE
    WHEN v.launch IN ('held', 'aborted') THEN now()
    WHEN e."runtime_instance_id" IS NULL AND v.phase = 'deleting' THEN now()
  END,
  CASE WHEN v.removal_kind = 'issued' THEN least((a."record"->'removal'->>'at')::timestamptz, now()) END,
  v.operation_id,
  CASE WHEN v.operation_completed THEN now() END,
  CASE WHEN v.absent_basis IS NOT NULL THEN coalesce(CASE WHEN o."presence" = 'absent' THEN o."observed_at" END, now()) END,
  v.absent_basis,
  CASE
    WHEN v.absent_basis IS NOT NULL THEN NULL
    WHEN v.phase = 'held' THEN a."record"->>'reason'
    -- An issue time in the future says nothing about how old the key is: never replayed.
    WHEN v.phase = 'issued' AND v.issued_at > now() THEN 'create-unresolved'
  END,
  CASE
    WHEN v.absent_basis IS NULL AND v.phase = 'held' AND a."record"->>'reason' = 'allocation-conflict'
      THEN a."record"->'conflictingSandboxes'
    ELSE '[]'::jsonb
  END
FROM "boat_allocations" a
LEFT JOIN "boat_executions" e ON e."runtime_instance_id" = a."runtime_instance_id"
LEFT JOIN "boat_observations" o ON o."runtime_instance_id" = a."runtime_instance_id"
LEFT JOIN "boat_tunnels" t ON t."runtime_instance_id" = a."runtime_instance_id"
CROSS JOIN LATERAL (
  SELECT
    a."record"->>'phase' AS phase,
    a."record"->'removal'->>'kind' AS removal_kind,
    (a."record"->>'issuedAt')::timestamptz AS issued_at,
    e."record"->>'phase' AS launch,
    CASE WHEN jsonb_typeof(e."record"->'admission') = 'object' THEN e."record"->'admission' END AS admission,
    -- Boat's deletion operation: on the allocation, or, for a row written before it moved there,
    -- on the run's tunnel reservation.
    coalesce(
      CASE WHEN a."record"->'removal'->>'kind' = 'operation' THEN a."record"->'removal'->>'id' END,
      CASE WHEN a."sandbox_id" IS NOT NULL THEN t."record"->'removal'->>'id' END
    ) AS operation_id
) w
CROSS JOIN LATERAL (
  SELECT
    w.*,
    w.operation_id IS NOT NULL AND coalesce(
      CASE WHEN w.removal_kind = 'operation' THEN (a."record"->'removal'->>'completed')::boolean END,
      (t."record"->'removal'->>'completed')::boolean,
      false
    ) AS operation_completed
) u
CROSS JOIN LATERAL (
  SELECT
    u.*,
    -- Absence, in the order Boat said it: its observed absence stands first; else what the
    -- allocation recorded of its end; else its completed deletion operation.
    CASE
      WHEN o."presence" = 'absent' THEN CASE o."basis" WHEN 'not-discovered' THEN 'never-created' ELSE o."basis" END
      WHEN u.phase = 'deleted' AND u.removal_kind = 'never-created' THEN 'never-created'
      WHEN u.phase = 'deleted' OR u.operation_completed THEN 'deletion-completed'
    END AS absent_basis
) v;
--> statement-breakpoint
-- (6) The tunnel reservation is the gateway host's port; it stays, and now belongs to the run's row.
ALTER TABLE "boat_tunnels" DROP CONSTRAINT "boat_tunnels_TblMwvLQ8gCt_fkey";--> statement-breakpoint
ALTER TABLE "boat_tunnels" ADD CONSTRAINT "boat_tunnels_runtime_instance_id_boat_runs_run_id_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "boat_runs"("run_id") ON DELETE RESTRICT;
--> statement-breakpoint
-- (7) Freeze the old tables. A statement-level trigger fires for a write that matches no row too,
-- so every write path of an older worker (its compare-and-set updates included) fails.
CREATE FUNCTION boat_ledger_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is frozen: Boat runs live in boat_runs since migration 20261110223249_boat_runs. This process predates it and must be upgraded; nothing was written.', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "boat_allocations_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "boat_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION boat_ledger_frozen();
--> statement-breakpoint
CREATE TRIGGER "boat_executions_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "boat_executions"
  FOR EACH STATEMENT EXECUTE FUNCTION boat_ledger_frozen();
--> statement-breakpoint
CREATE TRIGGER "boat_observations_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "boat_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION boat_ledger_frozen();
