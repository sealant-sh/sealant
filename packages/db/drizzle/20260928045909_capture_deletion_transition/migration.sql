ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_state" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_token" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_evidence_version" bigint;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_expires_at" timestamp with time zone;