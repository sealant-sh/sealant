CREATE TABLE "workspace_credential_placements" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"home" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"revision" integer NOT NULL,
	"path" text NOT NULL,
	"login" jsonb NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "credential_placements_revision_positive" CHECK ("revision" > 0),
	CONSTRAINT "credential_placements_state" CHECK ("state" in ('pending', 'ready', 'removing'))
);
--> statement-breakpoint
ALTER TABLE "workspace_credential_homes" ADD COLUMN "releasing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "credential_placements_account_state_idx" ON "workspace_credential_placements" ("account_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_placements_ready_slot_idx" ON "workspace_credential_placements" ("run_id","home","provider") WHERE "state" = 'ready';--> statement-breakpoint
ALTER TABLE "workspace_credential_placements" ADD CONSTRAINT "workspace_credential_placements_xuFtZjPIdlix_fkey" FOREIGN KEY ("run_id","home") REFERENCES "workspace_credential_homes"("run_id","home") ON DELETE CASCADE;--> statement-breakpoint
-- Every login an existing home holds becomes a placement. Homes recorded no revision, so the
-- account's current one is seeded. An archived or deleted account's file is left for the sweep.
INSERT INTO "workspace_credential_placements" ("id", "run_id", "home", "provider", "account_id", "revision", "path", "login", "state", "created_at")
SELECT 'cpl_' || md5(h."run_id" || chr(31) || h."home" || chr(31) || (entry->>'provider')),
       h."run_id", h."home", entry->>'provider', entry->>'connectedAccountId', COALESCE(a."credential_revision", 1),
       h."home" || '/' || CASE entry->>'provider'
         WHEN 'claude' THEN '.claude/.credentials.json'
         WHEN 'codex' THEN '.codex/auth.json'
         WHEN 'github' THEN '.config/gh/hosts.yml'
         WHEN 'pi' THEN '.pi/agent/auth.json'
         WHEN 'opencode' THEN '.local/share/opencode/auth.json' END,
       '{"kind":"subscription"}'::jsonb,
       CASE WHEN a."id" IS NULL OR a."status" = 'archived' OR a."archived_at" IS NOT NULL THEN 'removing' ELSE 'ready' END,
       h."created_at"
FROM "workspace_credential_homes" h
CROSS JOIN LATERAL jsonb_array_elements(h."accounts") entry
LEFT JOIN "connected_accounts" a ON a."id" = entry->>'connectedAccountId'
WHERE entry->>'provider' IN ('claude', 'codex', 'github', 'pi', 'opencode') AND entry->>'connectedAccountId' IS NOT NULL
ON CONFLICT DO NOTHING;
