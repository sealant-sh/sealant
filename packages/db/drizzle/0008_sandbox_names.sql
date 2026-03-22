ALTER TABLE `sandboxes` ADD `name` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `sandboxes`
SET `name` = COALESCE(
  (
    SELECT
      trim(COALESCE(`job`.`repository`, '') || ' ' || COALESCE(`job`.`tag`, ''))
    FROM `oci_image_build_jobs` AS `job`
    WHERE `job`.`run_id` = `sandboxes`.`latest_run_id`
    ORDER BY `job`.`created_at` DESC
    LIMIT 1
  ),
  ''
);
--> statement-breakpoint
UPDATE `sandboxes`
SET `name` = CASE
  WHEN trim(`name`) = '' THEN 'Sandbox ' || substr(`id`, 1, 8)
  ELSE `name`
END;
