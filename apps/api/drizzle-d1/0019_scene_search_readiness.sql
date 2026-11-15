ALTER TABLE `scene_index_runs` ADD `pending_vectors` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scene_index_tasks` ADD `accepted_at` text;--> statement-breakpoint
UPDATE `scene_index_tasks` SET `completed_at`=NULL,`accepted_at`=NULL,
  `last_error_code`='VECTORIZE_READINESS_REPLAY',`available_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  `lease_token`=NULL,`lease_until`=NULL
  WHERE `operation`='upsert' AND `completed_at` IS NOT NULL AND `last_error_code`<>'SUPERSEDED';--> statement-breakpoint
UPDATE `scene_index_runs` SET `pending_vectors`=(SELECT count(*) FROM `scene_index_tasks` t
  WHERE t.operation='upsert' AND t.revision=scene_index_runs.id AND t.video_id=scene_index_runs.video_id
    AND t.dimensions=scene_index_runs.dimensions AND (t.accepted_at IS NULL OR t.completed_at IS NULL));--> statement-breakpoint
UPDATE `videos` SET `status`='indexing' WHERE `status`='completed' AND EXISTS(
  SELECT 1 FROM `scenes` s JOIN `scene_index_tasks` t ON t.id='u:'||s.dimensions||':'||s.vector_id
  WHERE s.video_id=videos.id AND t.completed_at IS NULL AND t.last_error_code='VECTORIZE_READINESS_REPLAY');
