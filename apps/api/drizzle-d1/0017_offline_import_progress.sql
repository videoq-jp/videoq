CREATE TABLE `migration_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`archive_sha256` text NOT NULL,
	`mapping_sha256` text NOT NULL,
	`status` text NOT NULL,
	`table_index` integer DEFAULT 0 NOT NULL,
	`row_index` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
