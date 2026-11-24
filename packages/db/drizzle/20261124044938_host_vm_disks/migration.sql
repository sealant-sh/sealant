ALTER TABLE "workspace_runtime_instances" ADD COLUMN "host_vm_data_disk_path" text;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "host_vm_base_image_digest" text;--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" ADD COLUMN "capture_claimed_at" timestamp with time zone;