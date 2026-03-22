ALTER TABLE `workspace_runs` RENAME TO `sandbox_attempts`;
--> statement-breakpoint
ALTER TABLE `run_input_snapshots` RENAME TO `sandbox_attempt_snapshots`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_owner_user_id_status_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_repository_id_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_profile_revision_id_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_repository_profile_revision_id_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_issue_id_created_at_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_runs_status_started_at_idx`;
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_owner_user_id_status_created_at_idx` ON `sandbox_attempts` (`owner_user_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_repository_id_created_at_idx` ON `sandbox_attempts` (`repository_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_profile_revision_id_created_at_idx` ON `sandbox_attempts` (`profile_revision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_repository_profile_revision_id_created_at_idx` ON `sandbox_attempts` (`repository_profile_revision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_issue_id_created_at_idx` ON `sandbox_attempts` (`issue_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_attempts_status_started_at_idx` ON `sandbox_attempts` (`status`,`started_at`);
