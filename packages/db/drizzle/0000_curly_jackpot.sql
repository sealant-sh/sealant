CREATE TABLE `workspace_build_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`registry_id` text NOT NULL,
	`repository` text NOT NULL,
	`tag` text NOT NULL,
	`request_payload` text NOT NULL,
	`idempotency_key` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` integer NOT NULL,
	`claimed_at` integer,
	`lease_expires_at` integer,
	`worker_id` text,
	`started_at` integer,
	`finished_at` integer,
	`executor_id` text,
	`result_payload` text,
	`published_reference` text,
	`published_digest_reference` text,
	`published_digest` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_build_jobs_status_available_at_idx` ON `workspace_build_jobs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `workspace_build_jobs_status_claimed_at_idx` ON `workspace_build_jobs` (`status`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `workspace_build_jobs_created_at_idx` ON `workspace_build_jobs` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_build_jobs_idempotency_key_idx` ON `workspace_build_jobs` (`idempotency_key`);