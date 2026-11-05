ALTER TABLE "oci_image_build_jobs" ADD COLUMN "image_scope" jsonb;--> statement-breakpoint
ALTER TABLE "oci_image_build_jobs" ADD COLUMN "publication_id" text;--> statement-breakpoint
ALTER TABLE "oci_image_build_jobs" ADD COLUMN "publication" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "image_scope" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "publication_id" text;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "publication" jsonb;