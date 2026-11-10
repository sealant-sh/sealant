-- Boat snapshot parking and its custody ledger are removed. A Boat stop is the FINAL drain, then
-- the VM's deletion; a VM whose FINAL is incomplete is kept until FINAL completes or the owner
-- discards it. Nothing below touches a drain row that was never a custody root.
--
-- (1) Refuse to orphan a parked session. A custody root's only copy of unconfirmed work can be a
-- Boat saved snapshot that only the previous version knows how to resume or retire, so a database
-- that has one is not upgraded until that session is resumed or discarded there.
DO $$
DECLARE
  roots bigint;
  pins bigint;
BEGIN
  SELECT count(*) INTO roots FROM "workspace_capture_drains" WHERE "custody_contract" IS NOT NULL;
  IF roots > 0 THEN
    RAISE EXCEPTION 'Boat parked sessions exist: % row(s) of workspace_capture_drains have a custody contract. Resume or discard each of them on the previous version before upgrading; this migration drops the only record of their saved snapshots.', roots
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO pins FROM "native_publication_consumers" WHERE "state" = 'parked';
  IF pins > 0 THEN
    RAISE EXCEPTION 'Boat parked sessions exist: % native publication consumer(s) are in state parked. Resume or discard each of them on the previous version before upgrading.', pins
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;
--> statement-breakpoint
-- (2) The custody guards on tables that stay.
DROP TRIGGER "capture_custody_root_guard" ON "workspace_capture_drains";
DROP TRIGGER "capture_custody_monotonic_goal" ON "workspace_capture_drains";
DROP TRIGGER "capture_original_runtime_guard" ON "workspace_runtime_instances";
DROP TRIGGER "capture_publication_pin_guard" ON "native_publication_consumers";
DROP TRIGGER "boat_execution_child_authority" ON "boat_executions";
--> statement-breakpoint
-- (3) What ties workspace_capture_drains to the custody tables.
ALTER TABLE "workspace_capture_drains" DROP CONSTRAINT "capture_current_incarnation_fk";
ALTER TABLE "workspace_capture_drains" DROP CONSTRAINT "capture_retention_episode_fk";
ALTER TABLE "workspace_capture_drains" DROP CONSTRAINT "capture_custody_root_shape";
ALTER TABLE "workspace_capture_drains" DROP CONSTRAINT "capture_custody_claim_shape";
ALTER TABLE "workspace_capture_drains" DROP CONSTRAINT "capture_preservation_desired";
DROP INDEX "workspace_capture_drains_preservation_due";
--> statement-breakpoint
-- (4) The custody tables. Their foreign keys are circular, so each goes with CASCADE.
DROP TABLE "capture_retention_episodes" CASCADE;
DROP TABLE "capture_executor_incarnations" CASCADE;
DROP TABLE "capture_recovery_artifacts" CASCADE;
DROP TABLE "capture_preservation_operations" CASCADE;
DROP TABLE "capture_parking_closes" CASCADE;
DROP TABLE "capture_capsule_preparations" CASCADE;
DROP TABLE "capture_snapshot_saves" CASCADE;
DROP TABLE "capture_sandbox_removals" CASCADE;
DROP TABLE "capture_recovery_creates" CASCADE;
DROP TABLE "capture_recovery_admissions" CASCADE;
DROP TABLE "capture_snapshot_retirements" CASCADE;
DROP TABLE "capture_preservation_receipts" CASCADE;
DROP TABLE "capture_preservation_consumers" CASCADE;
DROP TABLE "boat_snapshot_allowance_observations" CASCADE;
DROP TABLE "capture_preservation_evidence" CASCADE;
--> statement-breakpoint
-- (5) The functions those triggers and tables used.
DROP FUNCTION capture_custody_root_guard();
DROP FUNCTION capture_custody_monotonic_goal();
DROP FUNCTION capture_original_runtime_guard();
DROP FUNCTION capture_publication_pin_guard();
DROP FUNCTION boat_execution_child_authority();
DROP FUNCTION capture_lineage_discharged(text);
DROP FUNCTION capture_custody_child_guard();
DROP FUNCTION capture_incarnation_guard();
DROP FUNCTION capture_operation_guard();
DROP FUNCTION capture_operation_detail_check();
DROP FUNCTION capture_parking_closes_kind_check();
DROP FUNCTION capture_capsule_preparations_kind_check();
DROP FUNCTION capture_snapshot_saves_kind_check();
DROP FUNCTION capture_sandbox_removals_kind_check();
DROP FUNCTION capture_sandbox_removal_guard();
DROP FUNCTION capture_recovery_creates_kind_check();
DROP FUNCTION capture_recovery_admissions_kind_check();
DROP FUNCTION capture_snapshot_retirements_kind_check();
DROP FUNCTION capture_artifact_guard();
DROP FUNCTION capture_removal_prerequisites();
DROP FUNCTION capture_consumer_guard();
DROP FUNCTION capture_issued_child_binding();
--> statement-breakpoint
-- (6) The custody columns.
ALTER TABLE "workspace_capture_drains" DROP COLUMN "custody_contract";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "preservation_desired";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "preservation_quarantine";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "custody_revision";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "current_incarnation_id";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "retention_episode_id";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "preservation_claim_token";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "preservation_claim_fence";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "preservation_claim_until";
ALTER TABLE "workspace_capture_drains" DROP COLUMN "next_preservation_action_at";
--> statement-breakpoint
-- (7) The ledger contract is '4' (CAPTURE_LEDGER_CONTRACT in
-- packages/db/src/repositories/workspace-capture-drains.ts): contract 2's invariants, (A)-(G), and
-- nothing else. Contract '3' added Boat custody; a '3' writer is the previous release, which still
-- believes in custody roots, so it is held to the old-writer guards like every other value.
CREATE OR REPLACE FUNCTION "workspace_capture_drains_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saved_old boolean;
  saved_new boolean;
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') = '4' THEN
    -- (G) For every writer, the current one included: an issued removal ends only as 'deleted',
    -- or with every request it sent whose outcome was unknown settled on the row (refused, done
    -- or fenced). A writer from before the contract is held to (B) below, which is stricter.
    IF TG_OP = 'UPDATE'
      AND OLD."deletion_state" = 'deleting-issued'
      AND NEW."deletion_state" IS DISTINCT FROM 'deleting-issued'
      AND NEW."deletion_state" IS DISTINCT FROM 'deleted'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD."deletion_requests") AS request(value)
        WHERE request.value ->> 'outcome' = 'unknown'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW."deletion_requests") AS settled(value)
            WHERE settled.value ->> 'id' = request.value ->> 'id'
              AND settled.value ->> 'outcome' IN ('refused', 'done', 'fenced')))
    THEN
      RAISE EXCEPTION 'workspace_capture_drains %: a request of this issued removal has an outcome nobody knows and may still act; the removal ends only as deleted or once that request is settled', NEW."run_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- (A) The unsaved answers on record.
  IF TG_OP = 'UPDATE' AND NEW."last_status" IS DISTINCT FROM OLD."last_status" AND OLD."last_status" IS NOT NULL THEN
    saved_old := coalesce(OLD."last_status" ->> 'complete', '') = 'true' AND NOT (jsonb_typeof(OLD."last_status") = 'object' AND OLD."last_status" ? 'incompleteReason');
    IF NOT saved_old AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."unsaved_statuses") AS member(value)
      WHERE member.value -> 'status' = OLD."last_status"
    ) THEN
      NEW."unsaved_statuses" := NEW."unsaved_statuses" || jsonb_build_array(jsonb_build_object(
        'status', OLD."last_status",
        'recordedAt', CASE WHEN OLD."last_status_recorded_at" IS NULL THEN NULL
          ELSE (extract(epoch FROM OLD."last_status_recorded_at") * 1000000)::bigint END));
    END IF;
  END IF;
  IF NEW."last_status" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."last_status" IS DISTINCT FROM OLD."last_status") THEN
    saved_new := coalesce(NEW."last_status" ->> 'complete', '') = 'true' AND NOT (jsonb_typeof(NEW."last_status") = 'object' AND NEW."last_status" ? 'incompleteReason');
    IF NOT saved_new AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."unsaved_statuses") AS member(value)
      WHERE member.value -> 'status' = NEW."last_status"
    ) THEN
      NEW."unsaved_statuses" := NEW."unsaved_statuses" || jsonb_build_array(jsonb_build_object(
        'status', NEW."last_status",
        'recordedAt', (extract(epoch FROM coalesce(NEW."last_status_recorded_at", now())) * 1000000)::bigint));
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- (B) An issued removal ends only as 'deleted'.
    IF OLD."deletion_state" = 'deleting-issued'
      AND NEW."deletion_state" IS DISTINCT FROM 'deleting-issued'
      AND NEW."deletion_state" IS DISTINCT FROM 'deleted' THEN
      NEW."deletion_state" := OLD."deletion_state";
      NEW."deletion_token" := OLD."deletion_token";
      NEW."deletion_evidence_version" := OLD."deletion_evidence_version";
      NEW."deletion_authorized_at" := OLD."deletion_authorized_at";
      NEW."deletion_issued_at" := OLD."deletion_issued_at";
      NEW."deletion_requests" := OLD."deletion_requests";
      NEW."deletion_expires_at" := least(OLD."deletion_expires_at", now());
    END IF;

    -- (F) No removal of an executor while an unsaved answer is on record (review 11 #4): an old
    -- reader weighs only the legacy status columns, which need not show what the set keeps.
    IF jsonb_array_length(NEW."unsaved_statuses") > 0 AND (
      (NEW."deletion_state" = 'deleting'
        AND (OLD."deletion_state" IS DISTINCT FROM 'deleting'
          OR NEW."deletion_token" IS DISTINCT FROM OLD."deletion_token"))
      OR (NEW."deletion_state" = 'deleting-issued'
        AND NEW."deletion_expires_at" > now()
        AND (OLD."deletion_state" IS DISTINCT FROM 'deleting-issued'
          OR NEW."deletion_expires_at" IS DISTINCT FROM OLD."deletion_expires_at"
          OR NEW."deletion_token" IS DISTINCT FROM OLD."deletion_token"))
      OR (NEW."deletion_state" = 'deleted' AND OLD."deletion_state" IS DISTINCT FROM 'deleted')
    ) THEN
      RAISE EXCEPTION 'workspace_capture_drains %: an answer of the executor that says its work is not saved is on record; no removal of it is authorized, sent or recorded by a writer that cannot weigh it', NEW."run_id"
        USING ERRCODE = 'check_violation';
    END IF;

    -- (C) A request of an issued removal only on the evidence it was authorized on.
    IF NEW."deletion_state" = 'deleting-issued'
      AND NEW."deletion_expires_at" > now()
      AND (OLD."deletion_state" IS DISTINCT FROM 'deleting-issued'
        OR NEW."deletion_expires_at" IS DISTINCT FROM OLD."deletion_expires_at"
        OR NEW."deletion_token" IS DISTINCT FROM OLD."deletion_token") THEN
      IF NEW."deletion_evidence_version" IS DISTINCT FROM NEW."evidence_version"
        OR NEW."observation_fences" <> '{}'::jsonb THEN
        RAISE EXCEPTION 'workspace_capture_drains %: the evidence this removal was authorized on changed; no request of it is sent again', NEW."run_id"
          USING ERRCODE = 'check_violation';
      END IF;
      NEW."deletion_issued_at" := now();
      -- Each request with its own outcome (review 11 #3): unknown until known.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW."deletion_requests") AS request(value)
        WHERE request.value ->> 'id' = NEW."deletion_token"
      ) THEN
        NEW."deletion_requests" := (
          SELECT jsonb_agg(CASE
              WHEN request.value ->> 'id' = NEW."deletion_token" AND request.value ->> 'outcome' = 'unknown'
                THEN jsonb_set(request.value, '{issuedAt}', to_jsonb((extract(epoch FROM now()) * 1000000)::bigint))
              ELSE request.value END ORDER BY request.position)
          FROM jsonb_array_elements(NEW."deletion_requests") WITH ORDINALITY AS request(value, position));
      ELSE
        NEW."deletion_requests" := NEW."deletion_requests" || jsonb_build_array(jsonb_build_object(
          'id', NEW."deletion_token",
          'issuedAt', (extract(epoch FROM now()) * 1000000)::bigint,
          'outcome', 'unknown'));
      END IF;
    END IF;

    -- (E) Not due before a live recovery claim ends.
    IF coalesce(NEW."recovery_lease_until" > now(), false)
      AND NEW."retained_at" IS NOT NULL
      AND NEW."next_recovery_at" IS DISTINCT FROM OLD."next_recovery_at"
      AND (NEW."next_recovery_at" IS NULL OR NEW."next_recovery_at" < NEW."recovery_lease_until") THEN
      NEW."next_recovery_at" := NEW."recovery_lease_until";
    END IF;
  END IF;

  -- (F) for a row an old writer inserts with a removal already on it.
  IF TG_OP = 'INSERT' AND jsonb_array_length(NEW."unsaved_statuses") > 0
    AND NEW."deletion_state" IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_capture_drains %: an answer of the executor that says its work is not saved is on record; no removal of it is authorized, sent or recorded by a writer that cannot weigh it', NEW."run_id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (D) No removal authorized over a live recovery claim.
  IF NEW."deletion_state" = 'deleting'
    AND coalesce(NEW."recovery_lease_until" > now(), false)
    AND (TG_OP = 'INSERT'
      OR OLD."deletion_state" IS DISTINCT FROM 'deleting'
      OR NEW."deletion_token" IS DISTINCT FROM OLD."deletion_token") THEN
    RAISE EXCEPTION 'workspace_capture_drains %: a recovery attempt holds this executor; no other removal is authorized until its claim ends', NEW."run_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- (8) No consumer is parked any more.
ALTER TABLE "native_publication_consumers" DROP CONSTRAINT "native_publication_consumers_state", ADD CONSTRAINT "native_publication_consumers_state" CHECK ("state" in ('pending','live','retained','unknown','released'));
