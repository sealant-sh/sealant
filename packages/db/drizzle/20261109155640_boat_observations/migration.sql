CREATE TABLE "boat_observations" (
	"runtime_instance_id" text PRIMARY KEY,
	"deployment_id" text NOT NULL,
	"sandbox_id" text,
	"presence" text NOT NULL,
	"basis" text NOT NULL,
	"provider_state" text,
	"created_observed_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boat_observations_shape" CHECK (("presence" = 'present' and "basis" = 'read' and "sandbox_id" is not null)
        or ("presence" = 'absent' and "basis" = 'not-found' and "sandbox_id" is not null and "created_observed_at" is not null)
        or ("presence" = 'absent' and "basis" = 'deletion-completed' and "sandbox_id" is not null)
        or ("presence" = 'absent' and "basis" = 'not-discovered' and "sandbox_id" is null))
);
--> statement-breakpoint
ALTER TABLE "boat_observations" ADD CONSTRAINT "boat_observations_qB9N0s2Gbhz2_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;