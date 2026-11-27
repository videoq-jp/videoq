CREATE TABLE `course_skill_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`input_key` text NOT NULL,
	`input` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`checkpoint` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_skill_builds_input_idx` ON `course_skill_builds` (`course_id`,`input_key`);--> statement-breakpoint
CREATE INDEX `course_skill_builds_queue_idx` ON `course_skill_builds` (`state`,`lease_until`);--> statement-breakpoint
CREATE TABLE `course_skill_inputs` (
	`course_id` integer PRIMARY KEY NOT NULL,
	`generation_enabled` integer DEFAULT 0 NOT NULL,
	`distribution_enabled` integer DEFAULT 0 NOT NULL,
	`policy_version` text DEFAULT '1' NOT NULL,
	`language` text DEFAULT 'ja' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`observed_input` text DEFAULT '' NOT NULL,
	`next_check_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `course_skill_inputs_due_idx` ON `course_skill_inputs` (`generation_enabled`,`next_check_at`);