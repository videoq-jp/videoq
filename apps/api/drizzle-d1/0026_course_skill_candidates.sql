CREATE TABLE `course_skill_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`build_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'review_required' NOT NULL,
	`approved_hash` text,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`build_id`) REFERENCES `course_skill_builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_skill_candidate_task_idx` ON `course_skill_candidates` (`build_id`,`skill_id`);--> statement-breakpoint
CREATE INDEX `course_skill_candidate_course_idx` ON `course_skill_candidates` (`course_id`);