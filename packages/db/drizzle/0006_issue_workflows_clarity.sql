DROP TABLE IF EXISTS `issue_run_links`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_pull_request_links`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_diff_files`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_validation_results`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_summaries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `run_artifacts`;
--> statement-breakpoint
CREATE TABLE `issue_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`owner_user_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`requested_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_workflows_issue_id_status_idx` ON `issue_workflows` (`issue_id`,`status`);
--> statement-breakpoint
CREATE INDEX `issue_workflows_repository_id_status_idx` ON `issue_workflows` (`repository_id`,`status`);
--> statement-breakpoint
CREATE INDEX `issue_workflows_owner_user_id_status_idx` ON `issue_workflows` (`owner_user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_workflow_id` text NOT NULL,
	`sandbox_id` text,
	`sandbox_attempt_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger_type` text DEFAULT 'manual' NOT NULL,
	`requested_by_user_id` text,
	`cancel_reason` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_workflow_id`) REFERENCES `issue_workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sandbox_attempt_id`) REFERENCES `sandbox_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_workflow_executions_workflow_id_created_at_idx` ON `issue_workflow_executions` (`issue_workflow_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_executions_status_started_at_idx` ON `issue_workflow_executions` (`status`,`started_at`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_executions_sandbox_id_created_at_idx` ON `issue_workflow_executions` (`sandbox_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_workflow_executions_sandbox_attempt_id_idx` ON `issue_workflow_executions` (`sandbox_attempt_id`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`storage_backend` text DEFAULT 'inline' NOT NULL,
	`storage_key` text,
	`content_type` text,
	`byte_size` integer,
	`checksum` text,
	`inline_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_artifacts_execution_id_kind_idx` ON `issue_workflow_execution_artifacts` (`execution_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_artifacts_storage_backend_storage_key_idx` ON `issue_workflow_execution_artifacts` (`storage_backend`,`storage_key`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`phase` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`payload` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_workflow_execution_events_execution_id_sequence_idx` ON `issue_workflow_execution_events` (`execution_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_events_execution_id_occurred_at_idx` ON `issue_workflow_execution_events` (`execution_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_events_execution_id_level_idx` ON `issue_workflow_execution_events` (`execution_id`,`level`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`check_key` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`message` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_workflow_execution_validation_results_execution_id_check_key_idx` ON `issue_workflow_execution_validation_results` (`execution_id`,`check_key`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_validation_results_execution_id_status_idx` ON `issue_workflow_execution_validation_results` (`execution_id`,`status`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_diff_files` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`change_type` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`is_binary` integer DEFAULT false NOT NULL,
	`patch_artifact_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patch_artifact_id`) REFERENCES `issue_workflow_execution_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_diff_files_execution_id_path_idx` ON `issue_workflow_execution_diff_files` (`execution_id`,`path`);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_diff_files_execution_id_change_type_idx` ON `issue_workflow_execution_diff_files` (`execution_id`,`change_type`);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_summaries` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`objective` text,
	`linked_issue_ref` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`summary_markdown` text,
	`generated_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_workflow_execution_pull_request_links` (
	`execution_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`relation` text DEFAULT 'created' NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`execution_id`, `pull_request_id`),
	FOREIGN KEY (`execution_id`) REFERENCES `issue_workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_workflow_execution_pull_request_links_pull_request_id_relation_idx` ON `issue_workflow_execution_pull_request_links` (`pull_request_id`,`relation`);
