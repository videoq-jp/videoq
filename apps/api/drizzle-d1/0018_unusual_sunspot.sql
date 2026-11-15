CREATE TABLE `teaching_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`installation_id` text NOT NULL,
	`context_id` text NOT NULL,
	`teacher_subject` text NOT NULL,
	`resource_link_id` text,
	`owner_user_id` text NOT NULL,
	`course_id` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "teaching_connections_provider_check" CHECK("teaching_connections"."provider" IN ('moodle','classroom'))
);
--> statement-breakpoint
CREATE INDEX `teaching_connections_owner_idx` ON `teaching_connections` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teaching_connections_context_key` ON `teaching_connections` (`provider`,`installation_id`,`context_id`);--> statement-breakpoint
ALTER TABLE `lti_chat_log_subjects` ADD `classroom_author` text;