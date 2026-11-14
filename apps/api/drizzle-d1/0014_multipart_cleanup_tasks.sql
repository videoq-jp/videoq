PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_external_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`locked_at` text,
	`completed_at` text,
	`dead_at` text,
	`effect_applied_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "external_tasks_kind_check" CHECK(kind IN ('sqs_job', 'storage_cleanup', 'invitation_email', 'multipart_abort', 'multipart_cleanup')),
	CONSTRAINT "external_tasks_attempts_check" CHECK(attempts >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_external_tasks`("id", "kind", "payload", "dedupe_key", "attempts", "available_at", "locked_at", "completed_at", "dead_at", "effect_applied_at", "last_error", "created_at", "updated_at") SELECT "id", "kind", "payload", "dedupe_key", "attempts", "available_at", "locked_at", "completed_at", "dead_at", "effect_applied_at", "last_error", "created_at", "updated_at" FROM `external_tasks`;--> statement-breakpoint
DROP TABLE `external_tasks`;--> statement-breakpoint
ALTER TABLE `__new_external_tasks` RENAME TO `external_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `external_tasks_ready_idx` ON `external_tasks` (`available_at`,`id`) WHERE completed_at IS NULL AND dead_at IS NULL;--> statement-breakpoint
CREATE INDEX `external_tasks_completed_idx` ON `external_tasks` (`completed_at`,`id`) WHERE completed_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `external_tasks_dedupe_key_key` ON `external_tasks` (`dedupe_key`);