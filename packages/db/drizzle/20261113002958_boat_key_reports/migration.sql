CREATE TABLE "boat_key_reports" (
	"account" text PRIMARY KEY,
	"report" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "boat_key_reports_account" CHECK ("account" = 'default' or "account" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "boat_accounts" ADD COLUMN "boat_organization" text;