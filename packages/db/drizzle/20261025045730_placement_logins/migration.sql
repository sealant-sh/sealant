DROP INDEX "credential_placements_ready_slot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "credential_placements_ready_slot_idx" ON "workspace_credential_placements" ("run_id","home","path") WHERE "state" = 'ready';--> statement-breakpoint
UPDATE "workspace_credential_placements" p
SET "login" = jsonb_build_object('kind', 'api-key', 'suffix', a."metadata"->>'tokenSuffix')
FROM "connected_accounts" a
WHERE a."id" = p."account_id"
  AND p."provider" = 'codex'
  AND p."login"->>'kind' = 'subscription'
  AND p."revision" = a."credential_revision"
  AND a."kind" = 'api-key'
  AND COALESCE(a."metadata"->>'tokenSuffix', '') <> '';
