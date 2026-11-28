CREATE TABLE `course_skill_files` (
	`revision_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `path`),
	FOREIGN KEY (`revision_id`) REFERENCES `course_skill_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `course_skill_heads` (
	`course_id` integer NOT NULL,
	`skill_id` text NOT NULL,
	`revision_id` text NOT NULL,
	PRIMARY KEY(`course_id`, `skill_id`),
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `course_skill_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `course_skill_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`course_id` integer NOT NULL,
	`skill_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content_hash` text NOT NULL,
	`state` text DEFAULT 'staged' NOT NULL,
	`sources` text NOT NULL,
	`manifest` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `course_skill_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `course_skill_publications_course_idx` ON `course_skill_publications` (`course_id`,`skill_id`);