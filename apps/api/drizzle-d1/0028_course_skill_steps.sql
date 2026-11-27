CREATE TABLE `course_skill_steps` (
	`key` text PRIMARY KEY NOT NULL,
	`build_id` text NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `course_skill_builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `course_skill_steps_build_idx` ON `course_skill_steps` (`build_id`);