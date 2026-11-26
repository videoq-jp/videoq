CREATE TABLE `policy_cleanup` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`task_id` text NOT NULL,
	`logical_deleted_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "policy_cleanup_scope_check" CHECK("policy_cleanup"."scope" IN ('active-object','active-index'))
);
--> statement-breakpoint
CREATE TABLE `policy_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` text,
	`delivered_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy_readiness` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`source_revision` text NOT NULL,
	`transcript_accepted_at` text NOT NULL,
	`ready_at` text,
	`ready_fingerprint` text,
	`ready_dimensions` integer,
	`ready_run_id` text,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE TRIGGER policy_source_accepted_insert AFTER INSERT ON video_index_versions
WHEN EXISTS (SELECT 1 FROM mutation_receipts WHERE resource_id=NEW.video_id AND kind IN ('transcription_saved','video_transcript_update'))
BEGIN
 DELETE FROM policy_readiness WHERE video_id=NEW.video_id AND EXISTS(SELECT 1 FROM videos WHERE id=NEW.video_id AND trim(coalesce(transcript,''),char(9)||char(10)||char(13)||' ')='');
 INSERT INTO policy_readiness(video_id,source_revision,transcript_accepted_at)
 SELECT NEW.video_id,NEW.revision,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM videos WHERE id=NEW.video_id AND trim(coalesce(transcript,''),char(9)||char(10)||char(13)||' ')<>''
 ON CONFLICT(video_id) DO UPDATE SET source_revision=excluded.source_revision,transcript_accepted_at=excluded.transcript_accepted_at,ready_at=NULL,ready_fingerprint=NULL,ready_dimensions=NULL,ready_run_id=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER policy_source_accepted_update AFTER UPDATE OF revision ON video_index_versions
WHEN OLD.revision<>NEW.revision AND EXISTS (SELECT 1 FROM mutation_receipts WHERE resource_id=NEW.video_id AND kind IN ('transcription_saved','video_transcript_update'))
BEGIN
 DELETE FROM policy_readiness WHERE video_id=NEW.video_id AND EXISTS(SELECT 1 FROM videos WHERE id=NEW.video_id AND trim(coalesce(transcript,''),char(9)||char(10)||char(13)||' ')='');
 INSERT INTO policy_readiness(video_id,source_revision,transcript_accepted_at)
 SELECT NEW.video_id,NEW.revision,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM videos WHERE id=NEW.video_id AND trim(coalesce(transcript,''),char(9)||char(10)||char(13)||' ')<>''
 ON CONFLICT(video_id) DO UPDATE SET source_revision=excluded.source_revision,transcript_accepted_at=excluded.transcript_accepted_at,ready_at=NULL,ready_fingerprint=NULL,ready_dimensions=NULL,ready_run_id=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER policy_source_ready AFTER UPDATE OF status ON scene_index_runs
WHEN NEW.status='published'
BEGIN
 UPDATE policy_readiness SET
 ready_at=CASE WHEN ready_run_id=(SELECT r.id FROM video_index_heads h JOIN scene_index_runs r ON h.run_id=r.id WHERE h.video_id=policy_readiness.video_id AND h.dimensions=NEW.dimensions) THEN coalesce(ready_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
 ready_fingerprint=(SELECT r.embedding_fingerprint FROM video_index_heads h JOIN scene_index_runs r ON h.run_id=r.id WHERE h.video_id=policy_readiness.video_id AND h.dimensions=NEW.dimensions),
 ready_dimensions=NEW.dimensions,
 ready_run_id=(SELECT run_id FROM video_index_heads WHERE video_id=policy_readiness.video_id AND dimensions=NEW.dimensions)
 WHERE video_id=NEW.video_id AND EXISTS(SELECT r.id FROM video_index_heads h JOIN scene_index_runs r ON r.id=h.run_id JOIN video_index_versions v ON v.video_id=h.video_id
 WHERE h.video_id=policy_readiness.video_id AND r.source_revision=policy_readiness.source_revision AND v.revision=policy_readiness.source_revision
 AND r.status='published' AND r.embedding_fingerprint IS NOT NULL AND r.embedding_identity IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM scenes s LEFT JOIN scene_index_tasks t ON t.id='u:'||s.dimensions||':'||s.vector_id
  WHERE s.video_id=h.video_id AND s.dimensions=h.dimensions AND (s.revision<>r.id OR t.id IS NULL OR t.accepted_at IS NULL OR t.completed_at IS NULL)) AND h.dimensions=NEW.dimensions);
END;
--> statement-breakpoint
CREATE TRIGGER policy_vector_ready AFTER UPDATE OF completed_at ON scene_index_tasks
WHEN NEW.operation='upsert' AND NEW.accepted_at IS NOT NULL AND NEW.completed_at IS NOT NULL
BEGIN
 UPDATE policy_readiness SET
 ready_at=CASE WHEN ready_run_id=(SELECT r.id FROM video_index_heads h JOIN scene_index_runs r ON h.run_id=r.id WHERE h.video_id=policy_readiness.video_id AND h.dimensions=NEW.dimensions) THEN coalesce(ready_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
 ready_fingerprint=(SELECT r.embedding_fingerprint FROM video_index_heads h JOIN scene_index_runs r ON h.run_id=r.id WHERE h.video_id=policy_readiness.video_id AND h.dimensions=NEW.dimensions),
 ready_dimensions=NEW.dimensions,
 ready_run_id=(SELECT run_id FROM video_index_heads WHERE video_id=policy_readiness.video_id AND dimensions=NEW.dimensions)
 WHERE video_id=NEW.video_id AND EXISTS(SELECT r.id FROM video_index_heads h JOIN scene_index_runs r ON r.id=h.run_id JOIN video_index_versions v ON v.video_id=h.video_id
 WHERE h.video_id=policy_readiness.video_id AND r.source_revision=policy_readiness.source_revision AND v.revision=policy_readiness.source_revision
 AND r.status='published' AND r.embedding_fingerprint IS NOT NULL AND r.embedding_identity IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM scenes s LEFT JOIN scene_index_tasks t ON t.id='u:'||s.dimensions||':'||s.vector_id
  WHERE s.video_id=h.video_id AND s.dimensions=h.dimensions AND (s.revision<>r.id OR t.id IS NULL OR t.accepted_at IS NULL OR t.completed_at IS NULL)) AND h.dimensions=NEW.dimensions);
END;
--> statement-breakpoint
CREATE TRIGGER policy_deleted BEFORE DELETE ON videos
BEGIN
 INSERT OR IGNORE INTO policy_cleanup(id,scope,task_id,logical_deleted_at,completed_at)
 SELECT 'object:'||id,'active-object',CAST(id AS text),strftime('%Y-%m-%dT%H:%M:%fZ','now'),completed_at
 FROM external_tasks WHERE kind='storage_cleanup' AND dedupe_key='storage:video:'||OLD.id AND completed_at IS NULL;
 INSERT OR IGNORE INTO policy_cleanup(id,scope,task_id,logical_deleted_at,completed_at)
 SELECT 'index:'||id,'active-index',id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),completed_at
 FROM scene_index_tasks WHERE video_id=OLD.id AND operation='delete' AND completed_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER policy_object_cleaned AFTER UPDATE OF completed_at ON external_tasks WHEN NEW.completed_at IS NOT NULL
BEGIN UPDATE policy_cleanup SET completed_at=NEW.completed_at WHERE id='object:'||NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER policy_index_cleaned AFTER UPDATE OF completed_at ON scene_index_tasks WHEN NEW.completed_at IS NOT NULL
BEGIN UPDATE policy_cleanup SET completed_at=NEW.completed_at WHERE id='index:'||NEW.id; END;
