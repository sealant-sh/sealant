CREATE TABLE "workspace_egress_policies" (
	"workspace_id" text PRIMARY KEY,
	"network_policy" jsonb,
	"brokered_secrets" jsonb DEFAULT '[]' NOT NULL,
	"brokered_values_sealed" text,
	"encryption_key_id" text,
	"revocation_watermark" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_egress_proxies" (
	"run_id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"proxy_container" text NOT NULL,
	"admin_socket_path" text NOT NULL,
	"ca_cert_pem" text NOT NULL,
	"ca_key_sealed" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"ca_not_after" timestamp with time zone NOT NULL,
	"network" jsonb,
	"confirmed_policy_hash" text,
	"confirmed_revocation_watermark" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_egress_revocations" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"revocation_watermark" bigint NOT NULL,
	"kind" text NOT NULL,
	"target" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_egress_revocations_target" CHECK (("kind" = 'all') = ("target" is null))
);
--> statement-breakpoint
CREATE INDEX "workspace_egress_proxies_workspace_idx" ON "workspace_egress_proxies" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_egress_revocations_workspace_idx" ON "workspace_egress_revocations" ("workspace_id","revocation_watermark");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_egress_revocations_once" ON "workspace_egress_revocations" ("workspace_id","revocation_watermark","kind",coalesce("target", ''));--> statement-breakpoint
ALTER TABLE "workspace_egress_policies" ADD CONSTRAINT "workspace_egress_policies_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_egress_proxies" ADD CONSTRAINT "workspace_egress_proxies_run_id_workspace_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_egress_proxies" ADD CONSTRAINT "workspace_egress_proxies_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_egress_revocations" ADD CONSTRAINT "workspace_egress_revocations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;