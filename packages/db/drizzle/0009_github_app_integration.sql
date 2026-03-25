CREATE TABLE `github_app_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`external_installation_id` text NOT NULL,
	`external_account_id` text,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`target_type` text,
	`status` text DEFAULT 'active' NOT NULL,
	`permissions` text NOT NULL,
	`repository_selection` text DEFAULT 'all' NOT NULL,
	`installed_at` integer,
	`suspended_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_external_installation_id_idx` ON `github_app_installations` (`external_installation_id`);
--> statement-breakpoint
CREATE INDEX `github_app_installations_account_login_idx` ON `github_app_installations` (`account_login`);
--> statement-breakpoint
CREATE INDEX `github_app_installations_status_idx` ON `github_app_installations` (`status`);
--> statement-breakpoint
CREATE INDEX `github_app_installations_last_synced_at_idx` ON `github_app_installations` (`last_synced_at`);
--> statement-breakpoint
CREATE TABLE `github_installation_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`external_repository_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`is_private` integer DEFAULT true NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`pushed_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`installation_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_repositories_installation_external_repo_idx` ON `github_installation_repositories` (`installation_id`,`external_repository_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_repositories_installation_repository_id_idx` ON `github_installation_repositories` (`installation_id`,`repository_id`);
--> statement-breakpoint
CREATE INDEX `github_installation_repositories_full_name_idx` ON `github_installation_repositories` (`full_name`);
--> statement-breakpoint
CREATE INDEX `github_installation_repositories_removed_at_idx` ON `github_installation_repositories` (`removed_at`);
--> statement-breakpoint
CREATE INDEX `github_installation_repositories_last_synced_at_idx` ON `github_installation_repositories` (`last_synced_at`);
--> statement-breakpoint
CREATE TABLE `github_installation_user_grants` (
	`installation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`granted_by_user_id` text,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	PRIMARY KEY(`installation_id`, `user_id`),
	FOREIGN KEY (`installation_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_installation_user_grants_user_id_revoked_at_idx` ON `github_installation_user_grants` (`user_id`,`revoked_at`);
--> statement-breakpoint
CREATE INDEX `github_installation_user_grants_installation_id_revoked_at_idx` ON `github_installation_user_grants` (`installation_id`,`revoked_at`);
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`event_type` text NOT NULL,
	`action` text,
	`installation_external_id` text,
	`payload` text,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`status` text DEFAULT 'received' NOT NULL,
	`error_message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_webhook_deliveries_delivery_id_idx` ON `github_webhook_deliveries` (`delivery_id`);
--> statement-breakpoint
CREATE INDEX `github_webhook_deliveries_event_type_received_at_idx` ON `github_webhook_deliveries` (`event_type`,`received_at`);
--> statement-breakpoint
CREATE INDEX `github_webhook_deliveries_status_received_at_idx` ON `github_webhook_deliveries` (`status`,`received_at`);
