ALTER TABLE "workspaces" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "stop_reason" text;