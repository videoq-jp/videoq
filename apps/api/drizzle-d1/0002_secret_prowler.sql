CREATE TABLE `scene_index_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`dimensions` integer NOT NULL,
	`expected_scenes` integer NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scene_index_runs_dimensions_check" CHECK("scene_index_runs"."dimensions" IN (768,1536)),
	CONSTRAINT "scene_index_runs_count_check" CHECK("scene_index_runs"."expected_scenes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `scene_index_runs_video_idx` ON `scene_index_runs` (`video_id`);--> statement-breakpoint
CREATE TABLE `scene_index_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`vector_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`revision` text NOT NULL,
	`video_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`dimensions` integer NOT NULL,
	`embedding` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	`last_error_code` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "scene_index_tasks_dimensions_check" CHECK("scene_index_tasks"."dimensions" IN (768,1536)),
	CONSTRAINT "scene_index_tasks_operation_check" CHECK("scene_index_tasks"."operation" IN ('upsert','delete'))
);
--> statement-breakpoint
CREATE INDEX `scene_index_tasks_ready_idx` ON `scene_index_tasks` (`completed_at`,`available_at`);--> statement-breakpoint
CREATE TABLE `scene_staging` (
	`run_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`vector_id` text NOT NULL,
	`content` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`evidence_type` text NOT NULL,
	PRIMARY KEY(`run_id`, `scene_id`),
	FOREIGN KEY (`run_id`) REFERENCES `scene_index_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_staging_vector_idx` ON `scene_staging` (`vector_id`);--> statement-breakpoint
CREATE TABLE `video_index_heads` (
	`video_id` integer NOT NULL,
	`dimensions` integer NOT NULL,
	`run_id` text NOT NULL,
	PRIMARY KEY(`video_id`, `dimensions`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_index_versions` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `scenes` ADD `vector_id` text;