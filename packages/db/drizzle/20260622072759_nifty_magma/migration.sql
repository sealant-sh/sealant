CREATE TABLE "telemetry_artifacts" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"algo" text NOT NULL,
	"hash" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_backend" text DEFAULT 'inline' NOT NULL,
	"storage_key" text,
	"inline_bytes" bytea
);
--> statement-breakpoint
CREATE TABLE "telemetry_events" (
	"event_id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"execution_id" text,
	"session_id" text,
	"process_id" text,
	"request_id" text,
	"schema_version" integer NOT NULL,
	"sequence" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"monotonic_timestamp" bigint NOT NULL,
	"capture_method" integer NOT NULL,
	"confidence" integer NOT NULL,
	"payload_case" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_loss_spans" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_sequence" bigint,
	"to_sequence" bigint,
	"dropped_count" bigint,
	"priority" integer,
	"reason" text,
	"detected_via" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_run_epochs" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_sequence" bigint,
	"last_sequence" bigint,
	"events_persisted" bigint DEFAULT 0 NOT NULL,
	"close_reason" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telemetry_scrollback" (
	"event_id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"process_id" text,
	"session_id" text,
	"stream" integer NOT NULL,
	"stream_offset" bigint NOT NULL,
	"byte_count" bigint NOT NULL,
	"content_algo" text,
	"content_hash" text,
	"redacted" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"coalesced" boolean DEFAULT false NOT NULL,
	"original_byte_count" bigint,
	"sequence" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_timeline" (
	"event_id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"summary" text NOT NULL,
	"ref_json" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_artifacts_run_algo_hash_idx" ON "telemetry_artifacts" ("run_id","algo","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_events_runtime_sequence_idx" ON "telemetry_events" ("runtime_id","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_events_run_sequence_idx" ON "telemetry_events" ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_events_run_process_sequence_idx" ON "telemetry_events" ("run_id","process_id","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_events_run_case_sequence_idx" ON "telemetry_events" ("run_id","payload_case","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_loss_spans_run_idx" ON "telemetry_loss_spans" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_run_epochs_run_runtime_idx" ON "telemetry_run_epochs" ("run_id","runtime_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_scrollback_run_proc_stream_offset_idx" ON "telemetry_scrollback" ("run_id","process_id","stream","stream_offset");--> statement-breakpoint
CREATE INDEX "telemetry_scrollback_run_sequence_idx" ON "telemetry_scrollback" ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_timeline_run_sequence_idx" ON "telemetry_timeline" ("run_id","sequence");--> statement-breakpoint
ALTER TABLE "telemetry_artifacts" ADD CONSTRAINT "telemetry_artifacts_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_events" ADD CONSTRAINT "telemetry_events_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_loss_spans" ADD CONSTRAINT "telemetry_loss_spans_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_run_epochs" ADD CONSTRAINT "telemetry_run_epochs_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_scrollback" ADD CONSTRAINT "telemetry_scrollback_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_timeline" ADD CONSTRAINT "telemetry_timeline_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;