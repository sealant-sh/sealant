ALTER TABLE "workspace_capture_drains" ADD COLUMN "last_status_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "evidence_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "observation_fences" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_origin" jsonb;