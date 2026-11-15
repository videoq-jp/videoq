CREATE TABLE `conversation_checkpoint_writes` (
	`thread_id` text NOT NULL,
	`namespace` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`task_id` text NOT NULL,
	`idx` integer NOT NULL,
	`task_path` text DEFAULT '' NOT NULL,
	`channel` text NOT NULL,
	`value_type` text NOT NULL,
	`value` blob NOT NULL,
	PRIMARY KEY(`thread_id`, `namespace`, `checkpoint_id`, `task_id`, `idx`),
	FOREIGN KEY (`thread_id`) REFERENCES `chat_conversations`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_checkpoint_writes_lookup_idx` ON `conversation_checkpoint_writes` (`thread_id`,`namespace`,`checkpoint_id`);--> statement-breakpoint
CREATE TABLE `conversation_checkpoints` (
	`thread_id` text NOT NULL,
	`namespace` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`parent_id` text,
	`checkpoint_type` text NOT NULL,
	`checkpoint` blob NOT NULL,
	`metadata_type` text NOT NULL,
	`metadata` blob NOT NULL,
	PRIMARY KEY(`thread_id`, `namespace`, `checkpoint_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `chat_conversations`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
