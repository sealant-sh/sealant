CREATE TABLE "workspace_capture_drains" (
	"run_id" text PRIMARY KEY,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"state" text,
	"detail" text,
	"last_status" jsonb,
	"last_progress_at" timestamp with time zone,
	"unreachable_since" timestamp with time zone,
	"kept_logged" boolean DEFAULT false NOT NULL,
	"silent_logged" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone,
	"preservation_starts_at" timestamp with time zone,
	"upload_bytes_per_second" double precision,
	"upload_sample_bytes" double precision,
	"upload_sampled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "source_kind" text;--> statement-breakpoint
CREATE INDEX "workspace_capture_drains_state_idx" ON "workspace_capture_drains" ("state");--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD CONSTRAINT "workspace_capture_drains_run_id_workspace_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_attempts"("id") ON DELETE CASCADE;