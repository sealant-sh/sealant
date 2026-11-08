CREATE TABLE "boat_control_requests" (
	"id" uuid PRIMARY KEY,
	"runtime_instance_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sealed_access" text
);
--> statement-breakpoint
CREATE INDEX "boat_control_requests_expiry" ON "boat_control_requests" ("expires_at");--> statement-breakpoint
ALTER TABLE "boat_control_requests" ADD CONSTRAINT "boat_control_requests_aKb6YSwzaDNy_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "boat_executions"("runtime_instance_id") ON DELETE CASCADE;