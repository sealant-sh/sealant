ALTER TABLE "workspaces" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_owner_idempotency_key_idx" ON "workspaces" ("owner_user_id","idempotency_key");