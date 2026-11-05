ALTER TABLE "resource_domains" ADD COLUMN "owner_kind" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_instances" ADD COLUMN "secret_env_sealed" text;--> statement-breakpoint
ALTER TABLE "resource_instances" ADD COLUMN "secret_revision" text;--> statement-breakpoint
ALTER TABLE "resource_instances" ADD COLUMN "allocations" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD CONSTRAINT "resource_domains_owner_kind" CHECK ("owner_kind" in ('project', 'organization', 'instance'));