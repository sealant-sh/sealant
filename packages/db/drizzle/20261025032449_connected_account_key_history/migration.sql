ALTER TABLE "connected_accounts" ADD COLUMN "api_key_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "kind_unchecked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "connected_accounts" SET "kind_unchecked" = true WHERE "provider" = 'codex' AND "kind" = 'auth-json';--> statement-breakpoint
UPDATE "connected_accounts" SET "api_key_connected_at" = "created_at" WHERE "kind" = 'api-key';
