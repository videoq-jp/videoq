CREATE TABLE `visual_object_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`video_id` integer NOT NULL,
	`run_id` text NOT NULL,
	`file_key` text NOT NULL,
	`chunk_index` integer,
	`object_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`available_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visual_object_attempts_due_idx` ON `visual_object_attempts` (`status`,`available_at`);