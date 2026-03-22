CREATE TABLE `package_resolution_cache_entries` (
	`query` text PRIMARY KEY NOT NULL,
	`resolution_payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `package_resolution_cache_entries_expires_at_idx` ON `package_resolution_cache_entries` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `package_resolution_cache_entries_last_used_at_idx` ON `package_resolution_cache_entries` (`last_used_at`);
