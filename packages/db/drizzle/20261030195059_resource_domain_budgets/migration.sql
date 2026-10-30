CREATE TABLE "resource_domain_allocations" (
	"id" text PRIMARY KEY,
	"resource_domain_id" text NOT NULL,
	"use" text NOT NULL,
	"object_key" text NOT NULL,
	"source_allocation_id" text,
	"operation_key" text NOT NULL,
	"cpu_millicores" bigint DEFAULT 0 NOT NULL,
	"memory_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"protection_bytes" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_domain_allocations_state" CHECK ("state" in ('reserved', 'in-use', 'archived', 'released') and ("state" <> 'archived' or "use" = 'volume')),
	CONSTRAINT "resource_domain_allocations_shape" CHECK (("use" = 'compute' and "cpu_millicores" > 0 and "memory_bytes" > 0 and "storage_bytes" = 0 and "protection_bytes" = 0 and "source_allocation_id" is null)
      or ("use" = 'volume' and "cpu_millicores" = 0 and "memory_bytes" = 0 and "storage_bytes" > 0 and "protection_bytes" >= 0 and "source_allocation_id" is null)
      or ("use" = 'protection' and "cpu_millicores" = 0 and "memory_bytes" = 0 and "storage_bytes" = 0 and "protection_bytes" > 0 and "source_allocation_id" is not null)),
	CONSTRAINT "resource_domain_allocations_range" CHECK ("cpu_millicores" <= 9007199254740991 and "memory_bytes" <= 9007199254740991 and "storage_bytes" <= 9007199254740991 and "protection_bytes" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "resource_domains" ADD COLUMN "cpu_millicores" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD COLUMN "memory_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD COLUMN "storage_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD COLUMN "budget_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_domain_allocations_operation_idx" ON "resource_domain_allocations" ("resource_domain_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_domain_allocations_live_object_idx" ON "resource_domain_allocations" ("resource_domain_id","use","object_key") WHERE state <> 'released';--> statement-breakpoint
CREATE INDEX "resource_domain_allocations_source_idx" ON "resource_domain_allocations" ("source_allocation_id") WHERE state <> 'released';--> statement-breakpoint
ALTER TABLE "resource_domain_allocations" ADD CONSTRAINT "resource_domain_allocations_PD3IlmOmL1M0_fkey" FOREIGN KEY ("resource_domain_id") REFERENCES "resource_domains"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_domain_allocations" ADD CONSTRAINT "resource_domain_allocations_VizBo7HHIYPu_fkey" FOREIGN KEY ("source_allocation_id") REFERENCES "resource_domain_allocations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_domains" ADD CONSTRAINT "resource_domains_budget" CHECK ("cpu_millicores" between 0 and 9007199254740991 and "memory_bytes" between 0 and 9007199254740991 and "storage_bytes" between 0 and 9007199254740991 and "budget_revision" between 1 and 9007199254740991);