ALTER TABLE "native_publications" ADD COLUMN "boat_wallet" text;--> statement-breakpoint
ALTER TABLE "native_publications" ADD COLUMN "boat_wallet_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_accounts" ADD COLUMN "key_kind" text;--> statement-breakpoint
ALTER TABLE "boat_install" ADD COLUMN "organization" text;--> statement-breakpoint
ALTER TABLE "boat_install" ADD COLUMN "key_kind" text;--> statement-breakpoint
ALTER TABLE "boat_key_proofs" ADD COLUMN "boat_wallet" text;--> statement-breakpoint
ALTER TABLE "boat_key_proofs" ADD COLUMN "boat_wallet_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_runs" ADD COLUMN "boat_wallet" text;--> statement-breakpoint
ALTER TABLE "boat_runs" ADD COLUMN "boat_wallet_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
DROP INDEX "native_publications_key_active";--> statement-breakpoint
CREATE UNIQUE INDEX "native_publications_key_active" ON "native_publications" ("key_hash",coalesce("boat_wallet", '')) WHERE "state" not in ('removed','superseded','retiring') and "boat_wallet_state" <> 'unreachable';--> statement-breakpoint
ALTER TABLE "native_publications" ADD CONSTRAINT "native_publications_wallet" CHECK ("boat_wallet_state" in ('known','unknown','unreachable') and ("boat_wallet_state" = 'known' or "boat_wallet" is null));--> statement-breakpoint
ALTER TABLE "boat_accounts" ADD CONSTRAINT "boat_accounts_key_kind" CHECK ("key_kind" in ('personal','organization'));--> statement-breakpoint
ALTER TABLE "boat_key_proofs" ADD CONSTRAINT "boat_key_proofs_wallet" CHECK ("boat_wallet_state" in ('known','unknown','unreachable') and ("boat_wallet_state" = 'known' or "boat_wallet" is null));--> statement-breakpoint
ALTER TABLE "boat_runs" ADD CONSTRAINT "boat_runs_wallet" CHECK ("boat_wallet_state" in ('known','unknown','unreachable') and ("boat_wallet_state" = 'known' or "boat_wallet" is null));--> statement-breakpoint
ALTER TABLE "boat_runs" DROP CONSTRAINT "boat_runs_absence", ADD CONSTRAINT "boat_runs_absence" CHECK (("absent_at" is null and "absent_basis" is null)
        or ("absent_at" is not null and "absent_basis" = 'not-found' and "sandbox_id" is not null and "created_seen_at" is not null)
        or ("absent_at" is not null and "absent_basis" = 'deletion-completed' and "sandbox_id" is not null)
        or ("absent_at" is not null and "absent_basis" = 'never-created' and "sandbox_id" is null)
        or ("absent_at" is not null and "absent_basis" = 'unreachable'));--> statement-breakpoint
-- What each key is, from its last report.
UPDATE "boat_accounts" a SET "key_kind" = r."report"->'keyKind'->>'kind'
  FROM "boat_key_reports" r
  WHERE r."account" = a."id"::text
    AND r."report"->'keyKind'->>'observed' = 'true'
    AND r."report"->'keyKind'->>'kind' IN ('personal', 'organization');--> statement-breakpoint
UPDATE "boat_install" i SET "key_kind" = r."report"->'keyKind'->>'kind'
  FROM "boat_key_reports" r
  WHERE r."account" = 'default'
    AND r."report"->'keyKind'->>'observed' = 'true'
    AND r."report"->'keyKind'->>'kind' IN ('personal', 'organization');--> statement-breakpoint
-- A pinned account named its pin on every request it made: its objects are in that wallet.
UPDATE "boat_runs" x SET "boat_wallet" = a."boat_organization", "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."account_id" = a."id" AND a."boat_organization" IS NOT NULL;--> statement-breakpoint
UPDATE "native_publications" x SET "boat_wallet" = a."boat_organization", "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."deployment_id" = a."deployment_id" AND a."boat_organization" IS NOT NULL;--> statement-breakpoint
UPDATE "boat_key_proofs" x SET "boat_wallet" = a."boat_organization", "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."account" = a."id"::text AND a."boat_organization" IS NOT NULL;--> statement-breakpoint
-- An organization's key has one wallet: its objects are in it, and no request names it.
UPDATE "boat_runs" x SET "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."account_id" = a."id" AND a."boat_organization" IS NULL AND a."key_kind" = 'organization';--> statement-breakpoint
UPDATE "native_publications" x SET "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."deployment_id" = a."deployment_id" AND a."boat_organization" IS NULL AND a."key_kind" = 'organization';--> statement-breakpoint
UPDATE "boat_key_proofs" x SET "boat_wallet_state" = 'known'
  FROM "boat_accounts" a
  WHERE x."account" = a."id"::text AND a."boat_organization" IS NULL AND a."key_kind" = 'organization';--> statement-breakpoint
UPDATE "boat_runs" SET "boat_wallet_state" = 'known'
  WHERE "account_id" IS NULL
    AND EXISTS (SELECT 1 FROM "boat_install" WHERE "key_kind" = 'organization');--> statement-breakpoint
UPDATE "native_publications" x SET "boat_wallet_state" = 'known'
  FROM "boat_install" i
  WHERE x."deployment_id" = i."deployment_id" AND i."key_kind" = 'organization'
    AND NOT EXISTS (SELECT 1 FROM "boat_accounts" a WHERE a."deployment_id" = x."deployment_id");--> statement-breakpoint
UPDATE "boat_key_proofs" SET "boat_wallet_state" = 'known'
  WHERE "account" = 'default'
    AND EXISTS (SELECT 1 FROM "boat_install" WHERE "key_kind" = 'organization');
