CREATE TABLE "connected_accounts" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"invalid_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profile_connected_accounts" (
	"profile_id" text,
	"provider" text,
	"connected_account_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_connected_accounts_pkey" PRIMARY KEY("profile_id","provider")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_owner_provider_name_active_idx" ON "connected_accounts" ("owner_user_id","provider","name") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "connected_accounts_owner_provider_status_idx" ON "connected_accounts" ("owner_user_id","provider","status");--> statement-breakpoint
CREATE INDEX "profile_connected_accounts_connected_account_id_idx" ON "profile_connected_accounts" ("connected_account_id");--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_connected_accounts" ADD CONSTRAINT "profile_connected_accounts_profile_id_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_connected_accounts" ADD CONSTRAINT "profile_connected_accounts_b1BOWlnHbk5x_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id");