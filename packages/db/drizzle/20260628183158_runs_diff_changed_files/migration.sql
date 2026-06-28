ALTER TABLE "runs" ADD COLUMN "diff" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "changed_files" jsonb;