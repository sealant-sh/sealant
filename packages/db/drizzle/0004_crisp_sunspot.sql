ALTER TABLE `workspace_build_jobs` RENAME TO `oci_image_build_jobs`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_build_jobs_status_available_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_build_jobs_status_claimed_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_build_jobs_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_build_jobs_run_id_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_build_jobs_idempotency_key_idx`;
--> statement-breakpoint
CREATE INDEX `oci_image_build_jobs_status_available_at_idx` ON `oci_image_build_jobs` (`status`,`available_at`);
--> statement-breakpoint
CREATE INDEX `oci_image_build_jobs_status_claimed_at_idx` ON `oci_image_build_jobs` (`status`,`claimed_at`);
--> statement-breakpoint
CREATE INDEX `oci_image_build_jobs_created_at_idx` ON `oci_image_build_jobs` (`created_at`);
--> statement-breakpoint
CREATE INDEX `oci_image_build_jobs_run_id_idx` ON `oci_image_build_jobs` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oci_image_build_jobs_idempotency_key_idx` ON `oci_image_build_jobs` (`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `sandbox_runtime_instances` (
	`run_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`adapter` text,
	`resource_id` text,
	`reference` text,
	`endpoint` text,
	`error_code` text,
	`error_message` text,
	`launched_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workspace_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sandbox_runtime_instances_status_updated_at_idx` ON `sandbox_runtime_instances` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_runtime_instances_adapter_status_idx` ON `sandbox_runtime_instances` (`adapter`,`status`);
