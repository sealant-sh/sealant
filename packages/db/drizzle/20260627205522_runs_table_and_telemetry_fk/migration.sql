CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"sandbox_id" text NOT NULL,
	"attempt_id" text,
	"owner_user_id" text NOT NULL,
	"harness_id" text NOT NULL,
	"mode" text DEFAULT 'one-shot' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text,
	"exit_code" integer,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_artifacts" DROP CONSTRAINT "telemetry_artifacts_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "telemetry_events" DROP CONSTRAINT "telemetry_events_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "telemetry_loss_spans" DROP CONSTRAINT "telemetry_loss_spans_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "telemetry_run_epochs" DROP CONSTRAINT "telemetry_run_epochs_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "telemetry_scrollback" DROP CONSTRAINT "telemetry_scrollback_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "telemetry_timeline" DROP CONSTRAINT "telemetry_timeline_run_id_sandbox_attempts_id_fkey";--> statement-breakpoint
CREATE INDEX "runs_sandbox_id_created_at_idx" ON "runs" ("sandbox_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_owner_user_id_status_created_at_idx" ON "runs" ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "runs_attempt_id_idx" ON "runs" ("attempt_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_sandbox_id_sandboxes_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_attempt_id_sandbox_attempts_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "sandbox_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_artifacts" ADD CONSTRAINT "telemetry_artifacts_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_events" ADD CONSTRAINT "telemetry_events_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_loss_spans" ADD CONSTRAINT "telemetry_loss_spans_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_run_epochs" ADD CONSTRAINT "telemetry_run_epochs_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_scrollback" ADD CONSTRAINT "telemetry_scrollback_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_timeline" ADD CONSTRAINT "telemetry_timeline_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;