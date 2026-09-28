-- Review 12 #3: the ledger contract is versioned. The trigger trusted any write marked
-- sealant.capture_ledger = '1', but the review 11 Core writer, the release immediately before the
-- per-request removal outcomes (deletion_requests, review 11 #3), already set that marker without
-- keeping them: in an adjacent-version rolling deploy it released an issued removal on the refusal
-- of its latest request while an earlier request, accepted with its reply lost, could still act.
-- The current writer now marks '2' (CAPTURE_LEDGER_CONTRACT in
-- packages/db/src/repositories/workspace-capture-drains.ts); every other value, '1' and unset
-- alike, is a writer from before the contract and is held to (A)-(F).
--
-- RULE: bump the marker whenever the ledger contract changes (a new invariant, a new column a
-- writer must keep, a changed transition), in the same change as a migration that recreates this
-- function to trust only the new value. The previous release then falls under the old-writer
-- guards instead of bypassing them.
--
-- (G) is new and holds for every writer, the current one included: no transition out of
-- 'deleting-issued' other than to 'deleted' while a request it recorded is 'unknown', unless the
-- same write records that request settled (refused, done, or fenced: the runtime's bound on it
-- has passed).
CREATE OR REPLACE FUNCTION "workspace_capture_drains_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saved_old boolean;
  saved_new boolean;
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') = '2' THEN
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
