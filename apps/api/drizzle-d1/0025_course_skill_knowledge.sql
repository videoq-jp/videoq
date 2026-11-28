CREATE TABLE `course_skill_knowledge_chunks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`video_id` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `course_skill_knowledge_owner_video_idx` ON `course_skill_knowledge_chunks` (`owner_id`,`video_id`);