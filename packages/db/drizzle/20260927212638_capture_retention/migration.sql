ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_executor_id" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_epoch" bigint;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_capture_n" bigint;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_attested_by" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "retained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "retained_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "next_recovery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "last_recovery_error" text;--> statement-breakpoint
CREATE INDEX "workspace_capture_drains_retained_idx" ON "workspace_capture_drains" ("retained_at","next_recovery_at");