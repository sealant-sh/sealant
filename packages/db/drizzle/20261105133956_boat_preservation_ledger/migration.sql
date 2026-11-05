CREATE TABLE "boat_snapshot_allowance_observations" (
	"account_scope" text PRIMARY KEY,
	"included" integer NOT NULL,
	"used" integer NOT NULL,
	"extra" integer NOT NULL,
	"extra_daily_dollars" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "boat_allowance_counts" CHECK ("included" = 10 and "used" >= 0 and "extra" = greatest(0, "used" - "included") and "extra_daily_dollars" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capture_capsule_preparations" (
	"run_id" text,
	"operation_id" uuid,
	"close_operation_id" uuid NOT NULL,
	"durable_work_receipt_id" uuid NOT NULL,
	"path" text NOT NULL,
	"manifest_hash" text NOT NULL,
	CONSTRAINT "capture_capsule_preparations_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_executor_incarnations" (
	"run_id" text,
	"id" uuid,
	"runtime_instance_id" text NOT NULL UNIQUE,
	"deployment_id" text NOT NULL,
	"account_scope" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"disk_binding_id" uuid NOT NULL,
	"allocation_operation_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"capture_launch_id" text NOT NULL,
	"guest_epoch" uuid NOT NULL,
	"guest_manifest_hash" text NOT NULL,
	"parent_incarnation_id" uuid,
	"source_artifact_id" uuid,
	"compute_state" text DEFAULT 'unknown' NOT NULL,
	"compute_observed_at" timestamp with time zone,
	"indicative_hourly_dollars" double precision,
	"removed_at" timestamp with time zone,
	"removal_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_executor_incarnations_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_executor_scope_sandbox" UNIQUE("account_scope","sandbox_id"),
	CONSTRAINT "capture_executor_subject" UNIQUE("run_id","id","sandbox_id"),
	CONSTRAINT "capture_executor_parent" CHECK (("parent_incarnation_id" is null) = ("source_artifact_id" is null)),
	CONSTRAINT "capture_executor_compute" CHECK ("compute_state" in ('running','not-running','unknown') and ("compute_state" = 'unknown' or "compute_observed_at" is not null)),
	CONSTRAINT "capture_executor_removal" CHECK (("removed_at" is null) = ("removal_operation_id" is null))
);
--> statement-breakpoint
CREATE TABLE "capture_parking_closes" (
	"run_id" text,
	"operation_id" uuid,
	"disk_binding_id" uuid NOT NULL,
	"guest_epoch" uuid NOT NULL,
	"guest_manifest_hash" text NOT NULL,
	"policy_revision" text NOT NULL,
	CONSTRAINT "capture_parking_closes_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_preservation_consumers" (
	"run_id" text,
	"operation_id" uuid,
	"artifact_id" uuid,
	"released_at" timestamp with time zone,
	CONSTRAINT "capture_preservation_consumers_pkey" PRIMARY KEY("run_id","operation_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "capture_preservation_operations" (
	"run_id" text,
	"id" uuid,
	"kind" text NOT NULL,
	"episode_id" uuid NOT NULL,
	"incarnation_id" uuid NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"request_version" integer DEFAULT 1 NOT NULL,
	"request_digest" text NOT NULL,
	"evidence_version" bigint NOT NULL,
	"issued_fence" bigint,
	"issued_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"next_observation_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_preservation_operations_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_operation_kind_binding" UNIQUE("run_id","id","kind"),
	CONSTRAINT "capture_operation_kind" CHECK ("kind" in ('close-writer','prepare-capsule','save-snapshot','remove-sandbox','create-recovery','admit-recovery','retire-snapshot')),
	CONSTRAINT "capture_operation_state" CHECK ("state" in ('prepared','issued','unknown','settled')),
	CONSTRAINT "capture_operation_request" CHECK ("request_version" = 1 and "request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "capture_operation_issuance" CHECK (("state" = 'prepared' and "issued_at" is null and "issued_fence" is null and "settled_at" is null) or ("state" in ('issued','unknown') and "issued_at" is not null and "issued_fence" is not null and "settled_at" is null) or ("state" = 'settled' and "issued_at" is not null and "issued_fence" is not null and "settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "capture_preservation_receipts" (
	"run_id" text,
	"id" uuid,
	"operation_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"kind" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"provider_operation_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_preservation_receipts_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_receipt_kind" CHECK ("kind" in ('unknown','pending','removal-completed') and ("kind" <> 'removal-completed' or length("provider_operation_id") > 0))
);
--> statement-breakpoint
CREATE TABLE "capture_recovery_admissions" (
	"run_id" text,
	"operation_id" uuid,
	"create_operation_id" uuid NOT NULL,
	"hydrated_receipt_id" uuid NOT NULL,
	"rebind_receipt_id" uuid NOT NULL,
	"guest_epoch" uuid NOT NULL,
	CONSTRAINT "capture_recovery_admissions_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_recovery_artifacts" (
	"run_id" text,
	"id" uuid,
	"episode_id" uuid NOT NULL,
	"source_incarnation_id" uuid NOT NULL,
	"account_scope" text NOT NULL,
	"name" text NOT NULL,
	"snapshot_id" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"close_receipt_id" uuid,
	"private_scope_receipt_id" uuid,
	"namespace_receipt_id" uuid,
	"capsule_verification_receipt_id" uuid,
	"archive_hash" text,
	"archive_bytes" bigint,
	"verified_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "capture_recovery_artifacts_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_artifact_scope_name" UNIQUE("account_scope","name"),
	CONSTRAINT "capture_artifact_scope_snapshot" UNIQUE("account_scope","snapshot_id"),
	CONSTRAINT "capture_artifact_source_episode" UNIQUE("run_id","episode_id","source_incarnation_id"),
	CONSTRAINT "capture_artifact_name" CHECK ("name" ~ '^slnt-rp-[0-9a-f-]{36}$'),
	CONSTRAINT "capture_artifact_state" CHECK ("state" in ('reserved','saving','verified','retiring','removed','unknown')),
	CONSTRAINT "capture_artifact_verified" CHECK ("state" not in ('verified','retiring') or ("snapshot_id" is not null and length("snapshot_id") > 0 and "close_receipt_id" is not null and "private_scope_receipt_id" is not null and "namespace_receipt_id" is not null and "capsule_verification_receipt_id" is not null and "archive_hash" is not null and "archive_hash" ~ '^[0-9a-f]{64}$' and "archive_bytes" is not null and "archive_bytes" > 0 and "verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "capture_recovery_creates" (
	"run_id" text,
	"operation_id" uuid,
	"artifact_id" uuid NOT NULL,
	"source_removal_operation_id" uuid NOT NULL,
	"destination_incarnation_id" uuid NOT NULL,
	"destination_runtime_instance_id" text NOT NULL UNIQUE,
	"create_key" uuid NOT NULL UNIQUE,
	CONSTRAINT "capture_recovery_creates_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_retention_episodes" (
	"run_id" text,
	"id" uuid,
	"retained_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_basis" text NOT NULL,
	"delay_seconds" integer NOT NULL,
	"policy_revision" text NOT NULL,
	"eligible_at" timestamp with time zone NOT NULL,
	"discharged_at" timestamp with time zone,
	CONSTRAINT "capture_retention_episodes_pkey" PRIMARY KEY("run_id","id"),
	CONSTRAINT "capture_retention_delay" CHECK ("delay_seconds" between 300 and 604800),
	CONSTRAINT "capture_retention_deadline" CHECK ("eligible_at" = "retained_at" + "delay_seconds" * interval '1 second'),
	CONSTRAINT "capture_retention_basis" CHECK ("time_basis" in ('recorded','existing-retention'))
);
--> statement-breakpoint
CREATE TABLE "capture_sandbox_removals" (
	"run_id" text,
	"operation_id" uuid,
	"sandbox_id" text NOT NULL,
	"basis" text NOT NULL,
	"artifact_id" uuid,
	"close_operation_id" uuid,
	"resource_revocation_receipt_id" uuid,
	"provider_operation_id" text,
	CONSTRAINT "capture_sandbox_removals_pkey" PRIMARY KEY("run_id","operation_id"),
	CONSTRAINT "capture_removal_basis" CHECK ("basis" in ('verified-recovery-custody','final','discard') and ("basis" <> 'verified-recovery-custody' or ("artifact_id" is not null and "close_operation_id" is not null and "resource_revocation_receipt_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "capture_snapshot_retirements" (
	"run_id" text,
	"operation_id" uuid,
	"artifact_id" uuid NOT NULL,
	"discharge_receipt_id" uuid NOT NULL,
	"namespace_receipt_id" uuid NOT NULL,
	CONSTRAINT "capture_snapshot_retirements_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_snapshot_saves" (
	"run_id" text,
	"operation_id" uuid,
	"artifact_id" uuid NOT NULL,
	"capsule_operation_id" uuid NOT NULL,
	"private_scope_receipt_id" uuid NOT NULL,
	"namespace_receipt_id" uuid NOT NULL,
	CONSTRAINT "capture_snapshot_saves_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "custody_contract" integer;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "preservation_desired" text DEFAULT 'preserve' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "preservation_quarantine" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "custody_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "current_incarnation_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "retention_episode_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "preservation_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "preservation_claim_fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "preservation_claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "next_preservation_action_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_capture_drains_preservation_due" ON "workspace_capture_drains" ("next_preservation_action_at","run_id") WHERE "custody_contract" = 3 and "next_preservation_action_at" is not null;--> statement-breakpoint
CREATE INDEX "capture_executor_descendants" ON "capture_executor_incarnations" ("source_artifact_id","id");--> statement-breakpoint
CREATE INDEX "capture_consumer_artifact" ON "capture_preservation_consumers" ("artifact_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_operation_source_kind" ON "capture_preservation_operations" ("run_id","episode_id","incarnation_id","kind") WHERE "kind" <> 'retire-snapshot';--> statement-breakpoint
CREATE UNIQUE INDEX "capture_operation_writer_slot" ON "capture_preservation_operations" ("run_id") WHERE "kind" in ('close-writer','create-recovery','admit-recovery') and "state" <> 'settled';--> statement-breakpoint
CREATE INDEX "capture_operation_observation_due" ON "capture_preservation_operations" ("next_observation_at","id") WHERE "state" in ('issued','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "capture_retention_one_open" ON "capture_retention_episodes" ("run_id") WHERE "discharged_at" is null;--> statement-breakpoint
ALTER TABLE "capture_capsule_preparations" ADD CONSTRAINT "capture_capsule_preparations_ztdQNoxZwHGg_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_capsule_preparations" ADD CONSTRAINT "capture_capsule_preparations_V2rUtovKsaBi_fkey" FOREIGN KEY ("run_id","close_operation_id") REFERENCES "capture_parking_closes"("run_id","operation_id");--> statement-breakpoint
ALTER TABLE "capture_executor_incarnations" ADD CONSTRAINT "capture_executor_incarnations_0UWZncjMw4Ux_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_capture_drains"("run_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capture_executor_incarnations" ADD CONSTRAINT "capture_executor_incarnations_pxZUyR7jJN5B_fkey" FOREIGN KEY ("publication_id") REFERENCES "native_publications"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capture_executor_incarnations" ADD CONSTRAINT "capture_executor_incarnations_AttIfTmw2jIH_fkey" FOREIGN KEY ("run_id","parent_incarnation_id") REFERENCES "capture_executor_incarnations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_parking_closes" ADD CONSTRAINT "capture_parking_closes_WoBkeedBQJOM_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_preservation_consumers" ADD CONSTRAINT "capture_preservation_consumers_F58EDF8QGMjq_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_preservation_consumers" ADD CONSTRAINT "capture_preservation_consumers_gvgj4fE7EvVx_fkey" FOREIGN KEY ("run_id","artifact_id") REFERENCES "capture_recovery_artifacts"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_preservation_operations" ADD CONSTRAINT "capture_preservation_operations_J7M7RDGDdTav_fkey" FOREIGN KEY ("run_id","episode_id") REFERENCES "capture_retention_episodes"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_preservation_operations" ADD CONSTRAINT "capture_preservation_operations_hjEKOBO5KrNG_fkey" FOREIGN KEY ("run_id","incarnation_id") REFERENCES "capture_executor_incarnations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_preservation_receipts" ADD CONSTRAINT "capture_preservation_receipts_7QSeRfdlF5Ms_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_admissions" ADD CONSTRAINT "capture_recovery_admissions_Zo0TooiSnObq_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_admissions" ADD CONSTRAINT "capture_recovery_admissions_q6axI1jaXKYH_fkey" FOREIGN KEY ("run_id","create_operation_id") REFERENCES "capture_recovery_creates"("run_id","operation_id");--> statement-breakpoint
ALTER TABLE "capture_recovery_artifacts" ADD CONSTRAINT "capture_recovery_artifacts_uczjb5nvIzQp_fkey" FOREIGN KEY ("run_id","episode_id") REFERENCES "capture_retention_episodes"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_artifacts" ADD CONSTRAINT "capture_recovery_artifacts_1N2bRRGS5bsC_fkey" FOREIGN KEY ("run_id","source_incarnation_id") REFERENCES "capture_executor_incarnations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_creates" ADD CONSTRAINT "capture_recovery_creates_1fZdY0NckBHb_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_creates" ADD CONSTRAINT "capture_recovery_creates_j0nBNbWyUQE8_fkey" FOREIGN KEY ("run_id","artifact_id") REFERENCES "capture_recovery_artifacts"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_recovery_creates" ADD CONSTRAINT "capture_recovery_creates_GjcgWImrGsVS_fkey" FOREIGN KEY ("run_id","source_removal_operation_id") REFERENCES "capture_sandbox_removals"("run_id","operation_id");--> statement-breakpoint
ALTER TABLE "capture_retention_episodes" ADD CONSTRAINT "capture_retention_episodes_5ndOmNMjpLLn_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_capture_drains"("run_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capture_sandbox_removals" ADD CONSTRAINT "capture_sandbox_removals_mr0RgOqmFytZ_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_sandbox_removals" ADD CONSTRAINT "capture_sandbox_removals_Ebpf5ZzJfNqW_fkey" FOREIGN KEY ("run_id","artifact_id") REFERENCES "capture_recovery_artifacts"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_sandbox_removals" ADD CONSTRAINT "capture_sandbox_removals_envZiQvP1XWr_fkey" FOREIGN KEY ("run_id","close_operation_id") REFERENCES "capture_parking_closes"("run_id","operation_id");--> statement-breakpoint
ALTER TABLE "capture_snapshot_retirements" ADD CONSTRAINT "capture_snapshot_retirements_7Oxroebg2LjX_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_snapshot_retirements" ADD CONSTRAINT "capture_snapshot_retirements_rEeWN4hCQKPu_fkey" FOREIGN KEY ("run_id","artifact_id") REFERENCES "capture_recovery_artifacts"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_snapshot_saves" ADD CONSTRAINT "capture_snapshot_saves_xKRRU6Qsv6v7_fkey" FOREIGN KEY ("run_id","operation_id") REFERENCES "capture_preservation_operations"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_snapshot_saves" ADD CONSTRAINT "capture_snapshot_saves_BmjNxGfIdWDK_fkey" FOREIGN KEY ("run_id","artifact_id") REFERENCES "capture_recovery_artifacts"("run_id","id");--> statement-breakpoint
ALTER TABLE "capture_snapshot_saves" ADD CONSTRAINT "capture_snapshot_saves_zx4xD3Tg5YI4_fkey" FOREIGN KEY ("run_id","capsule_operation_id") REFERENCES "capture_capsule_preparations"("run_id","operation_id");--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD CONSTRAINT "capture_preservation_desired" CHECK ("preservation_desired" in ('preserve','recover','discard'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workspace_capture_drains_invariants"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saved_old boolean;
  saved_new boolean;
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') = '3' THEN
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

    IF coalesce(NEW."recovery_lease_until" > now(), false)
      AND NEW."retained_at" IS NOT NULL
      AND NEW."next_recovery_at" IS DISTINCT FROM OLD."next_recovery_at"
      AND (NEW."next_recovery_at" IS NULL OR NEW."next_recovery_at" < NEW."recovery_lease_until") THEN
      NEW."next_recovery_at" := NEW."recovery_lease_until";
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND jsonb_array_length(NEW."unsaved_statuses") > 0
    AND NEW."deletion_state" IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_capture_drains %: an answer of the executor that says its work is not saved is on record; no removal of it is authorized, sent or recorded by a writer that cannot weigh it', NEW."run_id"
      USING ERRCODE = 'check_violation';
  END IF;

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
ALTER TABLE workspace_capture_drains ADD CONSTRAINT capture_current_incarnation_fk
  FOREIGN KEY (run_id, current_incarnation_id) REFERENCES capture_executor_incarnations(run_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE workspace_capture_drains ADD CONSTRAINT capture_retention_episode_fk
  FOREIGN KEY (run_id, retention_episode_id) REFERENCES capture_retention_episodes(run_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE capture_executor_incarnations ADD CONSTRAINT capture_incarnation_artifact_fk
  FOREIGN KEY (run_id, source_artifact_id) REFERENCES capture_recovery_artifacts(run_id, id);
ALTER TABLE capture_executor_incarnations ADD CONSTRAINT capture_incarnation_removal_fk
  FOREIGN KEY (run_id, removal_operation_id) REFERENCES capture_sandbox_removals(run_id, operation_id);
ALTER TABLE workspace_capture_drains ADD CONSTRAINT capture_custody_root_shape CHECK (
  (custody_contract IS NULL AND current_incarnation_id IS NULL AND retention_episode_id IS NULL
    AND preservation_claim_token IS NULL AND preservation_claim_until IS NULL AND next_preservation_action_at IS NULL)
  OR (custody_contract IS NOT NULL AND custody_contract = 3 AND current_incarnation_id IS NOT NULL));
ALTER TABLE workspace_capture_drains ADD CONSTRAINT capture_custody_claim_shape CHECK (
  (preservation_claim_token IS NULL) = (preservation_claim_until IS NULL));
ALTER TABLE capture_preservation_receipts ADD CONSTRAINT capture_completed_receipt_operation CHECK (
  kind <> 'removal-completed' OR (provider_operation_id IS NOT NULL AND length(provider_operation_id) > 0));
--> statement-breakpoint
CREATE FUNCTION capture_custody_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.custody_contract IS DISTINCT FROM OLD.custody_contract
      OR NEW.current_incarnation_id IS DISTINCT FROM OLD.current_incarnation_id
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
CREATE TRIGGER capture_custody_root_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_capture_drains
  FOR EACH ROW EXECUTE FUNCTION capture_custody_root_guard();
--> statement-breakpoint
CREATE FUNCTION capture_custody_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' THEN
    RAISE EXCEPTION 'capture custody requires writer contract 3' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'capture custody identity and receipts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_episode_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_retention_episodes
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE TRIGGER capture_receipt_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_preservation_receipts
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
--> statement-breakpoint
CREATE FUNCTION capture_incarnation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture incarnation requires current owner and immutable history' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'capture incarnation starts without a removal receipt' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['compute_state','compute_observed_at','indicative_hourly_dollars','removed_at','removal_operation_id'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['compute_state','compute_observed_at','indicative_hourly_dollars','removed_at','removal_operation_id'])
       OR (OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'capture incarnation identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.removed_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM capture_preservation_receipts r
      JOIN capture_sandbox_removals d ON d.run_id = r.run_id AND d.operation_id = r.operation_id
      JOIN capture_preservation_operations o ON o.run_id = d.run_id AND o.id = d.operation_id
      WHERE r.run_id = NEW.run_id AND r.operation_id = NEW.removal_operation_id
        AND r.kind = 'removal-completed' AND r.sandbox_id = NEW.sandbox_id
        AND r.provider_operation_id = d.provider_operation_id
        AND o.incarnation_id = NEW.id AND o.state = 'settled') THEN
      RAISE EXCEPTION 'capture removal requires exact completed operation receipt' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_incarnation_guard BEFORE INSERT OR UPDATE OR DELETE ON capture_executor_incarnations
  FOR EACH ROW EXECUTE FUNCTION capture_incarnation_guard();
--> statement-breakpoint
CREATE FUNCTION capture_original_runtime_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_capture_drains WHERE run_id = OLD.run_id AND custody_contract = 3) THEN
    IF TG_OP = 'DELETE' OR NEW.adapter IS DISTINCT FROM OLD.adapter OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.publication IS DISTINCT FROM OLD.publication
      OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
      OR NEW.publication_id IS DISTINCT FROM OLD.publication_id OR NEW.image_scope IS DISTINCT FROM OLD.image_scope THEN
      RAISE EXCEPTION 'capture original runtime identity is historical' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_original_runtime_guard BEFORE UPDATE OR DELETE ON workspace_runtime_instances
  FOR EACH ROW EXECUTE FUNCTION capture_original_runtime_guard();
--> statement-breakpoint
CREATE FUNCTION capture_publication_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root workspace_capture_drains;
BEGIN
  SELECT * INTO root FROM workspace_capture_drains WHERE run_id = OLD.run_id FOR UPDATE;
  IF root.custody_contract = 3 AND (TG_OP = 'DELETE' OR NEW.state = 'released'
      OR NEW.publication_id IS DISTINCT FROM OLD.publication_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
      OR NEW.runtime_instance_id IS DISTINCT FROM OLD.runtime_instance_id) THEN
    RAISE EXCEPTION 'capture custody keeps the native publication pinned' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_publication_pin_guard BEFORE UPDATE OR DELETE ON native_publication_consumers
  FOR EACH ROW EXECUTE FUNCTION capture_publication_pin_guard();
--> statement-breakpoint
CREATE FUNCTION capture_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture operation requires current owner and durable history' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['state','issued_fence','issued_at','settled_at','next_observation_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','issued_fence','issued_at','settled_at','next_observation_at'])
      OR (OLD.state <> 'prepared' AND (NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_fence IS DISTINCT FROM OLD.issued_fence))
      OR (OLD.state <> 'prepared' AND NEW.state = 'prepared')
      OR (OLD.state = 'settled' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'capture issued request cannot be reset or rewritten' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON capture_preservation_operations
  FOR EACH ROW EXECUTE FUNCTION capture_operation_guard();
--> statement-breakpoint
CREATE FUNCTION capture_operation_detail_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE detail_table text;
DECLARE present boolean;
BEGIN
  detail_table := CASE NEW.kind
    WHEN 'close-writer' THEN 'capture_parking_closes'
    WHEN 'prepare-capsule' THEN 'capture_capsule_preparations'
    WHEN 'save-snapshot' THEN 'capture_snapshot_saves'
    WHEN 'remove-sandbox' THEN 'capture_sandbox_removals'
    WHEN 'create-recovery' THEN 'capture_recovery_creates'
    WHEN 'admit-recovery' THEN 'capture_recovery_admissions'
    WHEN 'retire-snapshot' THEN 'capture_snapshot_retirements' END;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE run_id = $1 AND operation_id = $2)', detail_table)
    INTO present USING NEW.run_id, NEW.id;
  IF NOT present THEN
    RAISE EXCEPTION 'capture operation is missing typed detail' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER capture_operation_detail_check AFTER INSERT OR UPDATE ON capture_preservation_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION capture_operation_detail_check();

--> statement-breakpoint
CREATE TRIGGER capture_parking_closes_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_parking_closes
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_parking_closes_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'close-writer') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_parking_closes_kind_check BEFORE INSERT ON capture_parking_closes
  FOR EACH ROW EXECUTE FUNCTION capture_parking_closes_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_capsule_preparations_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_capsule_preparations
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_capsule_preparations_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'prepare-capsule') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_capsule_preparations_kind_check BEFORE INSERT ON capture_capsule_preparations
  FOR EACH ROW EXECUTE FUNCTION capture_capsule_preparations_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_snapshot_saves_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_snapshot_saves
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_snapshot_saves_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'save-snapshot') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_snapshot_saves_kind_check BEFORE INSERT ON capture_snapshot_saves
  FOR EACH ROW EXECUTE FUNCTION capture_snapshot_saves_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_sandbox_removals_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_sandbox_removals
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_sandbox_removals_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'remove-sandbox') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_sandbox_removals_kind_check BEFORE INSERT ON capture_sandbox_removals
  FOR EACH ROW EXECUTE FUNCTION capture_sandbox_removals_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_recovery_creates_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_recovery_creates
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_recovery_creates_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'create-recovery') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_recovery_creates_kind_check BEFORE INSERT ON capture_recovery_creates
  FOR EACH ROW EXECUTE FUNCTION capture_recovery_creates_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_recovery_admissions_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_recovery_admissions
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_recovery_admissions_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'admit-recovery') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_recovery_admissions_kind_check BEFORE INSERT ON capture_recovery_admissions
  FOR EACH ROW EXECUTE FUNCTION capture_recovery_admissions_kind_check();

--> statement-breakpoint
CREATE TRIGGER capture_snapshot_retirements_immutable BEFORE INSERT OR UPDATE OR DELETE ON capture_snapshot_retirements
  FOR EACH ROW EXECUTE FUNCTION capture_custody_child_guard();
CREATE FUNCTION capture_snapshot_retirements_kind_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM capture_preservation_operations WHERE run_id = NEW.run_id AND id = NEW.operation_id AND kind = 'retire-snapshot') THEN
    RAISE EXCEPTION 'capture operation typed detail kind mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_snapshot_retirements_kind_check BEFORE INSERT ON capture_snapshot_retirements
  FOR EACH ROW EXECUTE FUNCTION capture_snapshot_retirements_kind_check();

--> statement-breakpoint
CREATE FUNCTION capture_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture artifact requires current owner and permanent tombstone' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.episode_id IS DISTINCT FROM OLD.episode_id OR NEW.source_incarnation_id IS DISTINCT FROM OLD.source_incarnation_id
    OR NEW.account_scope IS DISTINCT FROM OLD.account_scope OR NEW.name IS DISTINCT FROM OLD.name
    OR (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
    OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
      OR NEW.close_receipt_id IS DISTINCT FROM OLD.close_receipt_id
      OR NEW.private_scope_receipt_id IS DISTINCT FROM OLD.private_scope_receipt_id
      OR NEW.namespace_receipt_id IS DISTINCT FROM OLD.namespace_receipt_id
      OR NEW.capsule_verification_receipt_id IS DISTINCT FROM OLD.capsule_verification_receipt_id
      OR NEW.archive_hash IS DISTINCT FROM OLD.archive_hash OR NEW.archive_bytes IS DISTINCT FROM OLD.archive_bytes))) THEN
    RAISE EXCEPTION 'capture artifact identity and custody cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON capture_recovery_artifacts
  FOR EACH ROW EXECUTE FUNCTION capture_artifact_guard();
--> statement-breakpoint
CREATE FUNCTION capture_removal_prerequisites() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'remove-sandbox' AND NEW.state <> 'prepared' AND NOT EXISTS (
    SELECT 1 FROM capture_sandbox_removals d
    JOIN capture_executor_incarnations i ON i.run_id = d.run_id AND i.id = NEW.incarnation_id AND i.sandbox_id = d.sandbox_id
    JOIN capture_recovery_artifacts a ON a.run_id = d.run_id AND a.id = d.artifact_id
    JOIN capture_preservation_operations c ON c.run_id = d.run_id AND c.id = d.close_operation_id
    WHERE d.run_id = NEW.run_id AND d.operation_id = NEW.id
      AND d.basis = 'verified-recovery-custody' AND a.state = 'verified'
      AND a.source_incarnation_id = NEW.incarnation_id AND a.episode_id = NEW.episode_id
      AND a.account_scope = i.account_scope AND a.verified_at <= NEW.issued_at
      AND c.kind = 'close-writer' AND c.state = 'settled' AND c.incarnation_id = NEW.incarnation_id
      AND c.episode_id = NEW.episode_id AND c.settled_at <= a.verified_at
      AND d.resource_revocation_receipt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'capture removal lacks verified target custody; final and discard executors are unavailable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER capture_removal_prerequisites AFTER INSERT OR UPDATE ON capture_preservation_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION capture_removal_prerequisites();
--> statement-breakpoint
CREATE FUNCTION capture_consumer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sealant.capture_ledger', true), '') <> '3' OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'capture consumer release requires lineage discharge integration' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_consumer_guard BEFORE INSERT OR UPDATE OR DELETE ON capture_preservation_consumers
  FOR EACH ROW EXECUTE FUNCTION capture_consumer_guard();
--> statement-breakpoint
CREATE FUNCTION capture_custody_monotonic_goal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.custody_contract = 3 AND (
      NEW.custody_revision < OLD.custody_revision OR NEW.preservation_claim_fence < OLD.preservation_claim_fence
      OR (OLD.discard_requested_at IS NOT NULL AND (NEW.discard_requested_at IS DISTINCT FROM OLD.discard_requested_at
        OR NEW.discard_requested_by IS DISTINCT FROM OLD.discard_requested_by OR NEW.preservation_desired <> 'discard'))
      OR (OLD.preservation_quarantine IS NOT NULL AND NEW.preservation_quarantine IS DISTINCT FROM OLD.preservation_quarantine)) THEN
    RAISE EXCEPTION 'capture custody goal, audit and quarantine are monotonic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_custody_monotonic_goal BEFORE UPDATE ON workspace_capture_drains
  FOR EACH ROW EXECUTE FUNCTION capture_custody_monotonic_goal();
--> statement-breakpoint
CREATE FUNCTION capture_issued_child_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'create-recovery' AND NOT EXISTS (
    SELECT 1 FROM capture_recovery_creates c
    JOIN capture_recovery_artifacts a ON a.run_id = c.run_id AND a.id = c.artifact_id
    JOIN capture_preservation_operations d ON d.run_id = c.run_id AND d.id = c.source_removal_operation_id
    JOIN capture_executor_incarnations i ON i.run_id = NEW.run_id AND i.id = NEW.incarnation_id
    JOIN capture_preservation_consumers p ON p.run_id = c.run_id AND p.operation_id = c.operation_id AND p.artifact_id = c.artifact_id AND p.released_at IS NULL
    WHERE c.run_id = NEW.run_id AND c.operation_id = NEW.id AND d.kind = 'remove-sandbox' AND d.state = 'settled'
      AND d.incarnation_id = NEW.incarnation_id AND d.episode_id = NEW.episode_id
      AND a.source_incarnation_id = NEW.incarnation_id AND a.episode_id = NEW.episode_id
      AND a.account_scope = i.account_scope AND a.state = 'verified' AND i.removed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'capture recovery requires completed source removal and pinned artifact' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER capture_issued_child_binding AFTER INSERT OR UPDATE ON capture_preservation_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION capture_issued_child_binding();
