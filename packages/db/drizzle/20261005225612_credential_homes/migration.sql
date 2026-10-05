CREATE TABLE "workspace_credential_homes" (
	"run_id" text,
	"home" text,
	"on_behalf_of_user_id" text NOT NULL,
	"accounts" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_credential_homes_pkey" PRIMARY KEY("run_id","home")
);
--> statement-breakpoint
ALTER TABLE "workspace_credential_homes" ADD CONSTRAINT "workspace_credential_homes_fLgyZlcnAX4O_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_runtime_instances"("run_id") ON DELETE CASCADE;