CREATE TABLE "resource_instances" (
	"id" text PRIMARY KEY,
	"resource_domain_id" text NOT NULL,
	"key" text NOT NULL,
	"alias" text NOT NULL,
	"worktree_key" text,
	"spec" jsonb NOT NULL,
	"spec_digest" text NOT NULL,
	"desired" text DEFAULT 'running' NOT NULL,
	"stop_reason" jsonb,
	"observed" jsonb DEFAULT '{"kind":"not-started"}' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"volumes" jsonb DEFAULT '[]' NOT NULL,
	"started_at" timestamp with time zone,
	"last_reached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "resource_instances_id_is_rin_uuid" CHECK ("id" ~ '^rin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "resource_instances_desired" CHECK ("desired" in ('running', 'stopped', 'archived')),
	CONSTRAINT "resource_instances_stop_reason" CHECK (("desired" = 'stopped') = ("stop_reason" is not null)),
	CONSTRAINT "resource_instances_archived_at" CHECK (("desired" = 'archived') = ("archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "resource_networks" (
	"name" text PRIMARY KEY,
	"kind" text NOT NULL,
	"subnet" cidr NOT NULL,
	"owner" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_networks_kind" CHECK ("kind" in ('reach', 'egress'))
);
--> statement-breakpoint
CREATE TABLE "resource_workspace_links" (
	"workspace_id" text PRIMARY KEY,
	"resource_domain_id" text NOT NULL,
	"worktree_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "resource_instances_key_idx" ON "resource_instances" ("resource_domain_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_instances_alias_idx" ON "resource_instances" ("resource_domain_id","alias",coalesce("worktree_key", '')) WHERE "desired" <> 'archived';--> statement-breakpoint
CREATE INDEX "resource_instances_live_idx" ON "resource_instances" ("resource_domain_id") WHERE "desired" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "resource_networks_subnet_idx" ON "resource_networks" ("subnet");--> statement-breakpoint
CREATE INDEX "resource_workspace_links_domain_idx" ON "resource_workspace_links" ("resource_domain_id","worktree_key");--> statement-breakpoint
ALTER TABLE "resource_instances" ADD CONSTRAINT "resource_instances_resource_domain_id_resource_domains_id_fkey" FOREIGN KEY ("resource_domain_id") REFERENCES "resource_domains"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_workspace_links" ADD CONSTRAINT "resource_workspace_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resource_workspace_links" ADD CONSTRAINT "resource_workspace_links_yC3NlJmsi54T_fkey" FOREIGN KEY ("resource_domain_id") REFERENCES "resource_domains"("id") ON DELETE RESTRICT;