CREATE TABLE "access_tokens" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"name" text,
	"token_hash" text NOT NULL UNIQUE,
	"scopes" jsonb NOT NULL,
	"workspace_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_sessions" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"daemon_session_id" text,
	"daemon_process_id" text,
	"argv" jsonb NOT NULL,
	"cwd" text,
	"cols" integer NOT NULL,
	"rows" integer NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"exit_code" integer,
	"exit_signal" integer,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "command" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "access_tokens_owner_user_id_idx" ON "access_tokens" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "workspace_sessions_workspace_id_created_at_idx" ON "workspace_sessions" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_sessions_owner_user_id_status_idx" ON "workspace_sessions" ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "workspace_sessions_run_id_idx" ON "workspace_sessions" ("run_id");--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;