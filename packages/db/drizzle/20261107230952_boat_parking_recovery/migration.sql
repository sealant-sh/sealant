ALTER TABLE "boat_executions" DROP CONSTRAINT "boat_executions_runtime_instance_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "boat_executions" ADD COLUMN "run_id" text;--> statement-breakpoint
UPDATE "boat_executions" SET "run_id" = "record"->'target'->>'runId';--> statement-breakpoint
ALTER TABLE "boat_executions" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_executions" ADD CONSTRAINT "boat_executions_run_id_workspace_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "boat_snapshot_allowance_observations" DROP CONSTRAINT "boat_allowance_counts", ADD CONSTRAINT "boat_allowance_counts" CHECK ("included" >= 10 and "used" >= 0 and "extra" = greatest(0, "used" - "included") and "extra_daily_dollars" >= 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_custody_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.custody_contract = 3 THEN
      RAISE EXCEPTION 'capture custody history cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.custody_contract = 3 THEN
    IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' THEN
      RAISE EXCEPTION 'capture custody requires writer contract 3' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.current_incarnation_id IS DISTINCT FROM OLD.current_incarnation_id AND NOT EXISTS (
      SELECT 1 FROM capture_executor_incarnations child
      JOIN capture_recovery_creates c ON c.run_id = child.run_id AND c.destination_incarnation_id = child.id
      JOIN capture_recovery_admissions a ON a.run_id = c.run_id AND a.create_operation_id = c.operation_id
      JOIN capture_preservation_operations op ON op.run_id = a.run_id AND op.id = a.operation_id
      JOIN capture_preservation_evidence e ON e.run_id = op.run_id AND e.operation_id = op.id AND e.kind = 'recovery-rebound'
      WHERE child.run_id = NEW.run_id AND child.id = NEW.current_incarnation_id
        AND child.parent_incarnation_id = OLD.current_incarnation_id AND child.removed_at IS NULL
        AND op.kind = 'admit-recovery' AND op.state = 'settled'
        AND OLD.preservation_desired = 'recover' AND NEW.preservation_desired = 'preserve'
        AND e.value->'target'->>'runtimeInstanceId' = child.runtime_instance_id
        AND e.value->'target'->>'sandboxId' = child.sandbox_id
    ) THEN
      RAISE EXCEPTION 'capture current promotion requires settled child readiness' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.custody_contract IS DISTINCT FROM OLD.custody_contract
      OR (OLD.retention_episode_id IS NOT NULL AND NEW.retention_episode_id IS DISTINCT FROM OLD.retention_episode_id)
      OR (OLD.retained_at IS NOT NULL AND NEW.retained_at IS DISTINCT FROM OLD.retained_at)
      OR (OLD.capture_token_sealed IS NOT NULL AND NEW.capture_token_sealed IS DISTINCT FROM OLD.capture_token_sealed)
      OR NEW.state IN ('stopped','discarded','gone')
      OR NEW.deletion_state IS NOT NULL
      OR NEW.recovery_lease_token IS NOT NULL
      OR NEW.lease_owner IS NOT NULL THEN
      RAISE EXCEPTION 'capture custody cannot use legacy completion, removal, drain or recovery' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.custody_contract IS NOT NULL THEN
    IF NEW.custody_contract <> 3 OR coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' THEN
      RAISE EXCEPTION 'capture custody requires writer contract 3' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deletion_state IS NOT NULL OR NEW.recovery_lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL THEN
      RAISE EXCEPTION 'capture custody cannot enroll an occupied legacy executor' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE FUNCTION boat_execution_child_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_instance_id <> NEW.run_id AND NOT EXISTS (
    SELECT 1 FROM capture_executor_incarnations child
    JOIN capture_executor_incarnations source ON source.run_id = child.run_id AND source.id = child.parent_incarnation_id
    JOIN workspace_capture_drains root ON root.run_id = child.run_id AND root.current_incarnation_id = source.id
    JOIN capture_recovery_creates c ON c.run_id = child.run_id AND c.destination_incarnation_id = child.id
    JOIN capture_preservation_operations op ON op.run_id = c.run_id AND op.id = c.operation_id
    JOIN capture_preservation_evidence e ON e.run_id = op.run_id AND e.operation_id = op.id AND e.kind = 'recovery-hydrated'
    WHERE child.run_id = NEW.run_id AND child.runtime_instance_id = NEW.runtime_instance_id
      AND child.sandbox_id = NEW.sandbox_id AND child.disk_binding_id::text = NEW.disk_lineage
      AND child.deployment_id = NEW.deployment_id AND source.removed_at IS NOT NULL
      AND root.custody_contract = 3 AND root.preservation_desired = 'recover'
      AND root.preservation_quarantine IS NULL AND op.state = 'settled'
      AND e.value = NEW.record->'target'
  ) THEN
    RAISE EXCEPTION 'Boat recovery execution requires canonical reserved child' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER boat_execution_child_authority BEFORE INSERT ON boat_executions FOR EACH ROW EXECUTE FUNCTION boat_execution_child_authority();
