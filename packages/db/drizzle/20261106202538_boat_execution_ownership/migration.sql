CREATE TABLE "boat_executions" (
	"runtime_instance_id" text PRIMARY KEY,
	"deployment_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"disk_lineage" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boat_executions_identity" CHECK ("record"->'target'->>'runtimeInstanceId' = "runtime_instance_id" and "record"->'target'->>'deploymentId' = "deployment_id" and "record"->'target'->>'sandboxId' = "sandbox_id" and "record"->'target'->>'diskLineage' = "disk_lineage")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "boat_executions_sandbox" ON "boat_executions" ("deployment_id","sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boat_executions_disk" ON "boat_executions" ("deployment_id","disk_lineage");--> statement-breakpoint
ALTER TABLE "boat_executions" ADD CONSTRAINT "boat_executions_runtime_instance_id_workspace_attempts_id_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;