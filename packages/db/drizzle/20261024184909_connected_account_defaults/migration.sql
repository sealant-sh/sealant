CREATE TABLE "connected_account_defaults" (
	"owner_user_id" text,
	"provider" text,
	"connected_account_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connected_account_defaults_pkey" PRIMARY KEY("owner_user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "credential_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_id_owner_provider_key" UNIQUE("id","owner_user_id","provider");--> statement-breakpoint
ALTER TABLE "connected_account_defaults" ADD CONSTRAINT "connected_account_defaults_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connected_account_defaults" ADD CONSTRAINT "connected_account_defaults_account_fkey" FOREIGN KEY ("connected_account_id","owner_user_id","provider") REFERENCES "connected_accounts"("id","owner_user_id","provider") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "connected_account_defaults" ("owner_user_id", "provider", "connected_account_id", "updated_at")
SELECT "owner_user_id", "provider", "id", now()
FROM "connected_accounts"
WHERE "name" = 'default' AND "archived_at" IS NULL
ON CONFLICT DO NOTHING;
