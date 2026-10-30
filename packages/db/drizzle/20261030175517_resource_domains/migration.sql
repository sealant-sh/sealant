CREATE TABLE "resource_domain_members" (
	"resource_domain_id" text,
	"user_id" text,
	"state" text NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_domain_members_pkey" PRIMARY KEY("resource_domain_id","user_id"),
	CONSTRAINT "resource_domain_members_state" CHECK ("state" in ('member', 'revoked')),
	CONSTRAINT "resource_domain_members_version" CHECK ("version" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "resource_domains" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_domains_id_is_rdm_uuid" CHECK ("id" ~ '^rdm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "resource_domains_key_idx" ON "resource_domains" ("key");--> statement-breakpoint
ALTER TABLE "resource_domain_members" ADD CONSTRAINT "resource_domain_members_B6mAYApnPqrQ_fkey" FOREIGN KEY ("resource_domain_id") REFERENCES "resource_domains"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "resource_domain_members" ADD CONSTRAINT "resource_domain_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_id_not_resource_domain" CHECK ("id" not like 'rdm:%');--> statement-breakpoint
ALTER TABLE "workspace_credential_homes" ADD CONSTRAINT "workspace_credential_homes_holder_not_resource_domain" CHECK ("on_behalf_of_user_id" not like 'rdm:%');