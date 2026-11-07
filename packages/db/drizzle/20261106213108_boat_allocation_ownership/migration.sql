CREATE TABLE "boat_allocations" (
	"runtime_instance_id" text PRIMARY KEY,
	"deployment_id" text NOT NULL,
	"publication_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL UNIQUE,
	"disk_lineage" uuid NOT NULL UNIQUE,
	"sandbox_id" text,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boat_allocations_identity" CHECK ("record"->'input'->'consumer'->>'runtimeInstanceId' = "runtime_instance_id" and "record"->'input'->>'deploymentId' = "deployment_id" and "record"->'input'->'publication'->>'publicationId' = "publication_id"::text and "record"->>'idempotencyKey' = "idempotency_key"::text and "record"->>'diskLineage' = "disk_lineage"::text and ("record"->>'sandboxId') is not distinct from "sandbox_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "boat_allocations_sandbox" ON "boat_allocations" ("deployment_id","sandbox_id");--> statement-breakpoint
CREATE INDEX "boat_allocations_reconcile" ON "boat_allocations" ("deployment_id","runtime_instance_id");--> statement-breakpoint
ALTER TABLE "boat_allocations" ADD CONSTRAINT "boat_allocations_runtime_instance_id_workspace_attempts_id_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "boat_allocations" ADD CONSTRAINT "boat_allocations_publication_id_native_publications_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "native_publications"("id") ON DELETE RESTRICT;