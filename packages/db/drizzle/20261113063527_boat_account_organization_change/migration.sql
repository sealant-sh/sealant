ALTER TABLE "boat_accounts" ADD COLUMN "organization_change_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boat_accounts" ADD COLUMN "organization_change_target" text;--> statement-breakpoint
ALTER TABLE "boat_accounts" ADD CONSTRAINT "boat_accounts_organization_change" CHECK ("organization_change_target" is null or "organization_change_requested_at" is not null);