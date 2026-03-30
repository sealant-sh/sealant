CREATE TABLE `issue_pull_request_links` (
	`issue_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`relation` text DEFAULT 'fixes' NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `pull_request_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_pull_request_links_pull_request_id_relation_idx` ON `issue_pull_request_links` (`pull_request_id`,`relation`);--> statement-breakpoint
CREATE TABLE `issue_run_links` (
	`issue_id` text NOT NULL,
	`run_id` text NOT NULL,
	`relation` text DEFAULT 'primary' NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `run_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_run_links_run_id_relation_idx` ON `issue_run_links` (`run_id`,`relation`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`external_id` text,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`url` text,
	`author_user_id` text,
	`assignee_user_id` text,
	`opened_at` integer,
	`closed_at` integer,
	`synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_provider_repository_id_number_idx` ON `issues` (`provider`,`repository_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_provider_external_id_idx` ON `issues` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `issues_repository_id_state_idx` ON `issues` (`repository_id`,`state`);--> statement-breakpoint
CREATE INDEX `issues_assignee_user_id_state_idx` ON `issues` (`assignee_user_id`,`state`);--> statement-breakpoint
CREATE TABLE `profile_env_vars` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_revision_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_env_vars_profile_revision_id_key_idx` ON `profile_env_vars` (`profile_revision_id`,`key`);--> statement-breakpoint
CREATE INDEX `profile_env_vars_profile_revision_id_idx` ON `profile_env_vars` (`profile_revision_id`);--> statement-breakpoint
CREATE TABLE `profile_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_by_user_id` text,
	`change_summary` text,
	`fingerprint` text NOT NULL,
	`config_patch` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_revisions_profile_id_version_idx` ON `profile_revisions` (`profile_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_revisions_profile_id_fingerprint_idx` ON `profile_revisions` (`profile_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `profile_revisions_created_by_user_id_idx` ON `profile_revisions` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `profile_revisions_created_at_idx` ON `profile_revisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `profile_secret_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_revision_id` text NOT NULL,
	`target_key` text NOT NULL,
	`secret_id` text NOT NULL,
	`secret_version_id` text,
	`is_required` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`secret_version_id`) REFERENCES `secret_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_secret_bindings_profile_revision_id_target_key_idx` ON `profile_secret_bindings` (`profile_revision_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `profile_secret_bindings_secret_id_idx` ON `profile_secret_bindings` (`secret_id`);--> statement-breakpoint
CREATE INDEX `profile_secret_bindings_profile_revision_id_idx` ON `profile_secret_bindings` (`profile_revision_id`);--> statement-breakpoint
CREATE TABLE `profile_ssh_key_bindings` (
	`profile_revision_id` text NOT NULL,
	`ssh_key_id` text NOT NULL,
	`purpose` text DEFAULT 'login' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`profile_revision_id`, `ssh_key_id`, `purpose`),
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ssh_key_id`) REFERENCES `ssh_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `profile_ssh_key_bindings_ssh_key_id_idx` ON `profile_ssh_key_bindings` (`ssh_key_id`);--> statement-breakpoint
CREATE TABLE `profile_ssh_settings` (
	`profile_revision_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`listen_port` integer DEFAULT 2222 NOT NULL,
	`host_allowlist` text NOT NULL,
	`session_timeout_minutes` integer,
	`authorized_keys_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_ssh_settings_enabled_idx` ON `profile_ssh_settings` (`enabled`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`active_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_owner_user_id_slug_idx` ON `profiles` (`owner_user_id`,`slug`);--> statement-breakpoint
CREATE INDEX `profiles_owner_user_id_status_idx` ON `profiles` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `profiles_active_revision_id_idx` ON `profiles` (`active_revision_id`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`external_id` text,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`head_sha` text,
	`url` text,
	`author_user_id` text,
	`opened_at` integer,
	`merged_at` integer,
	`closed_at` integer,
	`synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_provider_repository_id_number_idx` ON `pull_requests` (`provider`,`repository_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_provider_external_id_idx` ON `pull_requests` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `pull_requests_repository_id_state_idx` ON `pull_requests` (`repository_id`,`state`);--> statement-breakpoint
CREATE INDEX `pull_requests_head_sha_idx` ON `pull_requests` (`head_sha`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'generic' NOT NULL,
	`external_id` text,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`url` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_provider_owner_name_idx` ON `repositories` (`provider`,`owner`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_provider_external_id_idx` ON `repositories` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `repositories_owner_name_idx` ON `repositories` (`owner`,`name`);--> statement-breakpoint
CREATE INDEX `repositories_last_synced_at_idx` ON `repositories` (`last_synced_at`);--> statement-breakpoint
CREATE TABLE `repository_profile_profile_links` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_profile_revision_id` text NOT NULL,
	`profile_revision_id` text NOT NULL,
	`precedence` integer DEFAULT 0 NOT NULL,
	`is_required` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_profile_revision_id`) REFERENCES `repository_profile_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_profile_profile_links_repository_profile_revision_id_profile_revision_id_idx` ON `repository_profile_profile_links` (`repository_profile_revision_id`,`profile_revision_id`);--> statement-breakpoint
CREATE INDEX `repository_profile_profile_links_profile_revision_id_idx` ON `repository_profile_profile_links` (`profile_revision_id`);--> statement-breakpoint
CREATE TABLE `repository_profile_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_by_user_id` text,
	`change_summary` text,
	`fingerprint` text NOT NULL,
	`run_template` text NOT NULL,
	`policy_config` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_profile_id`) REFERENCES `repository_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_profile_revisions_repository_profile_id_version_idx` ON `repository_profile_revisions` (`repository_profile_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `repository_profile_revisions_repository_profile_id_fingerprint_idx` ON `repository_profile_revisions` (`repository_profile_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `repository_profile_revisions_created_at_idx` ON `repository_profile_revisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `repository_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`active_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_profiles_repository_id_name_idx` ON `repository_profiles` (`repository_id`,`name`);--> statement-breakpoint
CREATE INDEX `repository_profiles_repository_id_status_idx` ON `repository_profiles` (`repository_id`,`status`);--> statement-breakpoint
CREATE INDEX `repository_profiles_active_revision_id_idx` ON `repository_profiles` (`active_revision_id`);--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`storage_backend` text DEFAULT 'inline' NOT NULL,
	`storage_key` text,
	`content_type` text,
	`byte_size` integer,
	`checksum` text,
	`inline_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_artifacts_run_id_kind_idx` ON `run_artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `run_artifacts_storage_backend_storage_key_idx` ON `run_artifacts` (`storage_backend`,`storage_key`);--> statement-breakpoint
CREATE TABLE `run_diff_files` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`change_type` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`is_binary` integer DEFAULT false NOT NULL,
	`patch_artifact_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patch_artifact_id`) REFERENCES `run_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_diff_files_run_id_path_idx` ON `run_diff_files` (`run_id`,`path`);--> statement-breakpoint
CREATE INDEX `run_diff_files_run_id_change_type_idx` ON `run_diff_files` (`run_id`,`change_type`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`phase` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`payload` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_id_sequence_idx` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `run_events_run_id_occurred_at_idx` ON `run_events` (`run_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `run_events_run_id_level_idx` ON `run_events` (`run_id`,`level`);--> statement-breakpoint
CREATE TABLE `run_input_snapshots` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_spec_payload` text NOT NULL,
	`resolved_spec_payload` text NOT NULL,
	`blueprint_payload` text NOT NULL,
	`profile_config_snapshot` text,
	`repository_profile_config_snapshot` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_pull_request_links` (
	`run_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`relation` text DEFAULT 'created' NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `pull_request_id`),
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_pull_request_links_pull_request_id_relation_idx` ON `run_pull_request_links` (`pull_request_id`,`relation`);--> statement-breakpoint
CREATE TABLE `run_summaries` (
	`run_id` text PRIMARY KEY NOT NULL,
	`objective` text,
	`linked_issue_ref` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`assumptions` text NOT NULL,
	`warnings` text NOT NULL,
	`summary_markdown` text,
	`generated_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`check_key` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`message` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sandbox_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_validation_results_run_id_check_key_idx` ON `run_validation_results` (`run_id`,`check_key`);--> statement-breakpoint
CREATE INDEX `run_validation_results_run_id_status_idx` ON `run_validation_results` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `secret_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_id` text NOT NULL,
	`version` integer NOT NULL,
	`encrypted_value` text NOT NULL,
	`encryption_key_id` text,
	`value_sha256` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_versions_secret_id_version_idx` ON `secret_versions` (`secret_id`,`version`);--> statement-breakpoint
CREATE INDEX `secret_versions_created_by_user_id_idx` ON `secret_versions` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `secret_versions_secret_id_created_at_idx` ON `secret_versions` (`secret_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_owner_user_id_name_idx` ON `secrets` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE INDEX `secrets_owner_user_id_idx` ON `secrets` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key_secret_id` text,
	`passphrase_secret_id` text,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`private_key_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`passphrase_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_owner_user_id_fingerprint_idx` ON `ssh_keys` (`owner_user_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `ssh_keys_owner_user_id_name_idx` ON `ssh_keys` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE TABLE `sandbox_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`repository_id` text,
	`repository_profile_revision_id` text,
	`profile_revision_id` text,
	`issue_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger_type` text DEFAULT 'manual' NOT NULL,
	`trigger_ref` text,
	`requested_by_user_id` text,
	`retry_of_run_id` text,
	`cancel_reason` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repository_profile_revision_id`) REFERENCES `repository_profile_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sandbox_runs_owner_user_id_status_created_at_idx` ON `sandbox_runs` (`owner_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_repository_id_created_at_idx` ON `sandbox_runs` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_profile_revision_id_created_at_idx` ON `sandbox_runs` (`profile_revision_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_repository_profile_revision_id_created_at_idx` ON `sandbox_runs` (`repository_profile_revision_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_issue_id_created_at_idx` ON `sandbox_runs` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_status_started_at_idx` ON `sandbox_runs` (`status`,`started_at`);--> statement-breakpoint
ALTER TABLE `sandbox_build_jobs` ADD `run_id` text REFERENCES sandbox_runs(id);--> statement-breakpoint
CREATE INDEX `sandbox_build_jobs_run_id_idx` ON `sandbox_build_jobs` (`run_id`);