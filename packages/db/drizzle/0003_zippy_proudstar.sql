CREATE TABLE `sandbox_run_links` (
	`sandbox_id` text NOT NULL,
	`run_id` text NOT NULL,
	`relation` text DEFAULT 'launch' NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`sandbox_id`, `run_id`),
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `workspace_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_run_links_run_id_idx` ON `sandbox_run_links` (`run_id`);--> statement-breakpoint
CREATE INDEX `sandbox_run_links_sandbox_id_linked_at_idx` ON `sandbox_run_links` (`sandbox_id`,`linked_at`);--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`repository_id` text,
	`repository_profile_revision_id` text,
	`profile_revision_id` text,
	`requested_by_user_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`latest_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repository_profile_revision_id`) REFERENCES `repository_profile_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `profile_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`latest_run_id`) REFERENCES `workspace_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sandboxes_owner_user_id_status_created_at_idx` ON `sandboxes` (`owner_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandboxes_repository_id_created_at_idx` ON `sandboxes` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_latest_run_id_idx` ON `sandboxes` (`latest_run_id`);