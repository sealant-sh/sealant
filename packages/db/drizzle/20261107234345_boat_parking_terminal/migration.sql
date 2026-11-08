ALTER TABLE "boat_executions" ADD CONSTRAINT "boat_execution_run_binding" CHECK ("record"->'target'->>'runId' = "run_id");--> statement-breakpoint
CREATE FUNCTION capture_lineage_discharged(subject text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_capture_drains r
    JOIN capture_preservation_evidence e ON e.run_id = r.run_id AND e.kind = 'lineage-discharged'
    WHERE r.run_id = subject AND r.custody_contract = 3 AND r.preservation_quarantine IS NULL
      AND r.observation_fences = '{}'::jsonb AND r.preservation_desired <> 'recover'
      AND (r.preservation_desired = 'discard' OR (r.last_status->>'complete' = 'true' AND r.unsaved_statuses = '[]'::jsonb))
      AND e.value->>'currentIncarnationId' = r.current_incarnation_id::text
      AND e.value->>'evidenceVersion' = r.evidence_version::text
      AND NOT EXISTS (SELECT 1 FROM capture_executor_incarnations i WHERE i.run_id = subject AND i.removed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM capture_preservation_operations o WHERE o.run_id = subject AND o.kind <> 'retire-snapshot' AND o.state <> 'settled')
      AND NOT EXISTS (SELECT 1 FROM boat_tunnels t WHERE t.record->'binding'->'target'->>'runId' = subject AND t.released_at IS NULL)
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_consumer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture consumer requires canonical custody' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
    OR NOT capture_lineage_discharged(NEW.run_id)
  ) THEN
    RAISE EXCEPTION 'capture consumer release requires complete lineage discharge' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_publication_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root workspace_capture_drains;
BEGIN
  SELECT * INTO root FROM workspace_capture_drains WHERE run_id = OLD.run_id FOR UPDATE;
  IF root.custody_contract = 3 AND (
    TG_OP = 'DELETE' OR NEW.publication_id IS DISTINCT FROM OLD.publication_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.runtime_instance_id IS DISTINCT FROM OLD.runtime_instance_id
    OR (NEW.state = 'released' AND (
      NOT capture_lineage_discharged(OLD.run_id)
      OR EXISTS (SELECT 1 FROM capture_recovery_artifacts a WHERE a.run_id = OLD.run_id AND a.state <> 'removed')
      OR EXISTS (SELECT 1 FROM capture_preservation_operations o WHERE o.run_id = OLD.run_id AND o.state <> 'settled')
      OR EXISTS (SELECT 1 FROM capture_preservation_consumers c WHERE c.run_id = OLD.run_id AND c.released_at IS NULL)
    ))
  ) THEN
    RAISE EXCEPTION 'capture custody keeps the native publication pinned' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
