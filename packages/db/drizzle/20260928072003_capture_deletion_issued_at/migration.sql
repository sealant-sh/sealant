ALTER TABLE "workspace_capture_drains" ADD COLUMN "deletion_issued_at" timestamp with time zone;--> statement-breakpoint
-- A removal issued before this column: no earlier than its hold's last renewal (review 9 #5).
UPDATE "workspace_capture_drains" SET "deletion_issued_at" = "deletion_expires_at" WHERE "deletion_state" = 'deleting-issued';
