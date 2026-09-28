-- Review 10, decision 32: invariants of workspace_capture_drains that a Core process from before
-- them (a rolling deploy runs old and new side by side) would otherwise erase. A current writer
-- keeps them itself and marks its transaction (set_config('sealant.capture_ledger', '1', true));
-- for every write that is not marked, this trigger keeps them:
--  (A) every unsaved answer stays on record (unsaved_statuses, review 9 #4): the status a write
--      replaces, and the status it writes, join the set when they are not saved answers;
--  (B) an issued removal (deleting-issued) is never given up: only 'deleted' ends it; a write
--      that would release it leaves it issued, its hold ended, to be settled from the runtime;
--  (C) no request of an issued removal is sent (issued, issued again, or renewed) unless the
--      evidence it was authorized on still stands (review 10 #4), and its issue instant is
--      recorded (the runtime's bound on the request runs from it);
--  (D) no removal is authorized while a recovery attempt holds its live claim (review 10
--      residual 2);
--  (E) a claimed recovery is not made due before its claim ends (an old worker ignores claims
--      and lists what is due).
-- (C) and (D) fail the write: the old writer reads it as a failed check and keeps the executor.
CREATE OR REPLACE FUNCTION "workspace_capture_drains_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saved_old boolean;
  saved_new boolean;
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') = '1' THEN
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
      NEW."deletion_expires_at" := least(OLD."deletion_expires_at", now());
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
    END IF;

    -- (E) Not due before a live recovery claim ends.
    IF coalesce(NEW."recovery_lease_until" > now(), false)
      AND NEW."retained_at" IS NOT NULL
      AND NEW."next_recovery_at" IS DISTINCT FROM OLD."next_recovery_at"
      AND (NEW."next_recovery_at" IS NULL OR NEW."next_recovery_at" < NEW."recovery_lease_until") THEN
      NEW."next_recovery_at" := NEW."recovery_lease_until";
    END IF;
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
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_capture_drains_invariants"
  BEFORE INSERT OR UPDATE ON "workspace_capture_drains"
  FOR EACH ROW EXECUTE FUNCTION "workspace_capture_drains_invariants"();
