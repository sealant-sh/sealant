CREATE TABLE "boat_key_proofs" (
	"id" uuid PRIMARY KEY,
	"account" text NOT NULL,
	"create_key" uuid NOT NULL,
	"snapshot_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"claimed_until" timestamp with time zone NOT NULL,
	"create_issued_at" timestamp with time zone,
	"sandbox_id" text,
	"save_issued_at" timestamp with time zone,
	"vm_deleted_at" timestamp with time zone,
	"snapshot_deleted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cleanup_pending" boolean DEFAULT false NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "boat_key_proofs_one_running" ON "boat_key_proofs" ("account") WHERE "finished_at" is null or "cleanup_pending";