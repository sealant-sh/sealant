CREATE TABLE "capture_preservation_evidence" (
	"run_id" text,
	"id" uuid,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"value" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_preservation_evidence_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_evidence_operation_kind" UNIQUE("run_id","operation_id","kind"),
	CONSTRAINT "capture_evidence_digest" CHECK ("digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "capture_preservation_evidence" ADD CONSTRAINT "capture_preservation_evidence_ov0Ofwyj4zCs_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");
--> statement-breakpoint
CREATE TRIGGER capture_evidence_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_preservation_evidence
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
--> statement-breakpoint
DROP TRIGGER capture_sandbox_removals_immutable ON capture_sandbox_removals;
CREATE FUNCTION capture_sandbox_removal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture removal requires current owner and durable history' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - 'provider_operation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'provider_operation_id')
    OR OLD.provider_operation_id IS NOT NULL
    OR NEW.provider_operation_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM capture_preservation_operations o
      WHERE o.run_id = NEW.run_id AND o.id = NEW.operation_id AND o.state IN ('issued','unknown'))
  ) THEN
    RAISE EXCEPTION 'capture removal operation identity cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_sandbox_removals_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_sandbox_removals
  FOR EACH ROW EXECUTE FUNCTION capture_sandbox_removal_guard();
