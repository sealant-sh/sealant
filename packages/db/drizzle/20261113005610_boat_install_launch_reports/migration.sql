CREATE TABLE "boat_install" (
	"id" text PRIMARY KEY,
	"deployment_id" text,
	"builder_owner" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boat_install_one" CHECK ("id" = 'install')
);
--> statement-breakpoint
CREATE TABLE "boat_launch_reports" (
	"worker" text PRIMARY KEY,
	"launches" boolean NOT NULL,
	"default_account" boolean NOT NULL,
	"resource_gateway" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
