-- Boat accounts an install stores beside its default one (the env key). Every existing Boat run
-- belongs to the default account: `account_id` stays null for it, so nothing is backfilled and no
-- operator step is needed.
CREATE TABLE "boat_accounts" (
	"id" uuid PRIMARY KEY,
	"label" text NOT NULL,
	"deployment_id" text NOT NULL UNIQUE,
	"builder_owner" uuid NOT NULL UNIQUE,
	"sealed_key" text,
	"key_id" text,
	"key_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_rotated_at" timestamp with time zone,
	"removal_requested_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "boat_accounts_key" CHECK (("removed_at" is null) = ("sealed_key" is not null and "key_id" is not null)),
	CONSTRAINT "boat_accounts_removal" CHECK ("removed_at" is null or "removal_requested_at" is not null),
	CONSTRAINT "boat_accounts_label" CHECK (length("label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "boat_runs" ADD COLUMN "account_id" uuid;--> statement-breakpoint
CREATE INDEX "boat_runs_account" ON "boat_runs" ("account_id","run_id");--> statement-breakpoint
ALTER TABLE "boat_runs" ADD CONSTRAINT "boat_runs_account_id_boat_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "boat_accounts"("id") ON DELETE RESTRICT;