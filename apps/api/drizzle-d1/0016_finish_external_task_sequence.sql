-- Restore incoming references cleared by the generated table rebuild.
UPDATE lti_material_operations AS operation
SET external_task_id = (
  SELECT json_extract(task.payload,'$.external_task_id')
  FROM external_tasks AS task
  WHERE task.dedupe_key = 'migration:multipart-task-kinds:reference:' || operation.id
)
WHERE EXISTS (
  SELECT 1 FROM external_tasks AS task
  WHERE task.dedupe_key = 'migration:multipart-task-kinds:reference:' || operation.id
);
--> statement-breakpoint
DELETE FROM external_tasks
WHERE kind = 'storage_cleanup' AND completed_at IS NOT NULL
  AND dedupe_key = 'migration:multipart-task-kinds:reference:' || json_extract(payload,'$.operation_id');
--> statement-breakpoint
-- Remove the completed sequence sentinel after the table copy.
DELETE FROM external_tasks
WHERE dedupe_key = 'migration:multipart-task-kinds:sequence'
  AND kind = 'storage_cleanup' AND payload = '{}'
  AND completed_at IS NOT NULL;
