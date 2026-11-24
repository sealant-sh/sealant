ALTER TABLE "workspace_attempts" ADD COLUMN "control_scope" text;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "control_scope" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_attempts_control_scope_idx" ON "workspace_attempts" ("control_scope");