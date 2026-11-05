CREATE TABLE "native_publication_consumers" (
	"run_id" text,
	"runtime_instance_id" text,
	"publication_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "native_publication_consumers_pkey" PRIMARY KEY("run_id","runtime_instance_id"),
	CONSTRAINT "native_publication_consumers_state" CHECK ("state" in ('pending','live','retained','unknown','released')),
	CONSTRAINT "native_publication_consumers_instance" CHECK ("run_id" = "runtime_instance_id"),
	CONSTRAINT "native_publication_consumers_release" CHECK (("state" = 'released') = ("released_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "native_publications" (
	"id" uuid PRIMARY KEY,
	"build_id" uuid NOT NULL UNIQUE,
	"key_hash" text NOT NULL,
	"key_payload" jsonb NOT NULL,
	"deployment_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"recipe_hash" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_purpose" text,
	"claim_until" timestamp with time zone,
	"publication" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "native_publications_state" CHECK ("state" in ('reserved','building','ready','retiring','removed','quarantined')),
	CONSTRAINT "native_publications_generation" CHECK ("generation" >= 0),
	CONSTRAINT "native_publications_claim" CHECK (("claim_token" is null and "claim_until" is null and "claim_purpose" is null) or ("claim_token" is not null and "claim_until" is not null and "claim_purpose" in ('build','reconcile','remove'))),
	CONSTRAINT "native_publications_scope" CHECK ("scope_kind" in ('owner','resource-domain')),
	CONSTRAINT "native_publications_payload" CHECK (("state" in ('reserved','building') and "publication" is null) or ("state" in ('ready','retiring','removed') and "publication" is not null) or "state" = 'quarantined')
);
--> statement-breakpoint
CREATE INDEX "native_publication_consumers_pin" ON "native_publication_consumers" ("publication_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "native_publications_key_active" ON "native_publications" ("key_hash") WHERE "state" <> 'removed';--> statement-breakpoint
CREATE INDEX "native_publications_scope_retention" ON "native_publications" ("deployment_id","scope_kind","scope_id","state","created_at");--> statement-breakpoint
CREATE INDEX "native_publications_reconcile" ON "native_publications" ("state","claim_until");--> statement-breakpoint
ALTER TABLE "native_publication_consumers" ADD CONSTRAINT "native_publication_consumers_run_id_workspace_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workspace_attempts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "native_publication_consumers" ADD CONSTRAINT "native_publication_consumers_FGHITjgPWFcL_fkey" FOREIGN KEY ("publication_id") REFERENCES "native_publications"("id") ON DELETE RESTRICT;