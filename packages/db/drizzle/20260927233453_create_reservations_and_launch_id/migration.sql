CREATE TABLE "workspace_create_reservations" (
	"owner_user_id" text,
	"idempotency_key" text,
	"state" text NOT NULL,
	"workspace_id" text,
	"launch_id" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_create_reservations_pkey" PRIMARY KEY("owner_user_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "workspace_attempts" ADD COLUMN "launch_id" text;--> statement-breakpoint
ALTER TABLE "workspace_capture_drains" ADD COLUMN "completion_launch_id" text;--> statement-breakpoint
ALTER TABLE "workspace_create_reservations" ADD CONSTRAINT "workspace_create_reservations_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;