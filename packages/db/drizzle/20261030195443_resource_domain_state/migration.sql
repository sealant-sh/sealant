ALTER TABLE "resource_domain_allocations" ADD COLUMN "source_object_key" text;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_domain_allocations" ADD CONSTRAINT "resource_domain_allocations_source_key" CHECK (("use" = 'protection') = ("source_object_key" is not null));--> statement-breakpoint
ALTER TABLE "resource_domains" ADD CONSTRAINT "resource_domains_state" CHECK ("state" in ('active', 'fenced', 'archived'));