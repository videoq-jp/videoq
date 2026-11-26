-- Legacy provenance deliberately remains unknown; never adopt configured identity.
ALTER TABLE scene_index_runs ADD COLUMN embedding_fingerprint TEXT;
--> statement-breakpoint
ALTER TABLE scene_index_runs ADD COLUMN embedding_identity TEXT;
