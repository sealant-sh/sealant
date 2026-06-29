CREATE TABLE "principal_credential_versions" (
	"id" text PRIMARY KEY,
	"credential_id" text NOT NULL,
	"version" integer NOT NULL,
	"envelope" text NOT NULL,
	"kek_id" text NOT NULL,
	"value_sha256" text NOT NULL,
	"payload_shape" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal_credentials" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" text[],
	"account_identifier" text,
	"last4" text,
	"expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"token_family" text,
	"rotation_count" integer DEFAULT 0 NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "principal_credential_versions_credential_id_version_idx" ON "principal_credential_versions" ("credential_id","version");--> statement-breakpoint
CREATE INDEX "principal_credential_versions_credential_id_created_at_idx" ON "principal_credential_versions" ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "principal_credentials_owner_provider_kind_account_idx" ON "principal_credentials" ("owner_user_id","provider","kind","account_identifier");--> statement-breakpoint
CREATE INDEX "principal_credentials_owner_user_id_idx" ON "principal_credentials" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "principal_credentials_owner_provider_idx" ON "principal_credentials" ("owner_user_id","provider");--> statement-breakpoint
ALTER TABLE "principal_credential_versions" ADD CONSTRAINT "principal_credential_versions_ny9mmNxq9rky_fkey" FOREIGN KEY ("credential_id") REFERENCES "principal_credentials"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "principal_credential_versions" ADD CONSTRAINT "principal_credential_versions_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "principal_credentials" ADD CONSTRAINT "principal_credentials_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;