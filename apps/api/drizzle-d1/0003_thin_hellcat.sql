PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scenes` (
	`id` text NOT NULL,
	`video_id` integer NOT NULL,
	`content` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`evidence_type` text DEFAULT 'transcript' NOT NULL,
	`dimensions` integer NOT NULL,
	`revision` text NOT NULL,
	`vector_id` text,
	PRIMARY KEY(`id`, `dimensions`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scenes_dimensions_check" CHECK("__new_scenes"."dimensions" IN (768, 1536)),
	CONSTRAINT "scenes_evidence_type_check" CHECK("__new_scenes"."evidence_type" IN ('transcript', 'visual')),
	CONSTRAINT "scenes_id_length_check" CHECK(length(CAST("__new_scenes"."id" AS BLOB)) BETWEEN 1 AND 64)
);
--> statement-breakpoint
INSERT INTO `__new_scenes`("id", "video_id", "content", "start_time", "end_time", "evidence_type", "dimensions", "revision", "vector_id") SELECT "id", "video_id", "content", "start_time", "end_time", "evidence_type", "dimensions", "revision", "vector_id" FROM `scenes`;--> statement-breakpoint
DROP TABLE `scenes`;--> statement-breakpoint
ALTER TABLE `__new_scenes` RENAME TO `scenes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `scenes_video_idx` ON `scenes` (`video_id`);