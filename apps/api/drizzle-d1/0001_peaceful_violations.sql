CREATE TABLE `mutation_receipts` (
	`token` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`resource_id` integer NOT NULL,
	`effect_applied` integer DEFAULT false NOT NULL
);
