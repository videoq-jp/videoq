-- Retain a completed sentinel while SQLite rebuilds external_tasks. Its
-- autoincrement ID carries the historical high-water mark through the copy,
-- even when the highest ordinary rows were already pruned.
INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at)
VALUES ('storage_cleanup','{}','migration:multipart-task-kinds:sequence',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(dedupe_key) DO NOTHING;
--> statement-breakpoint
-- D1 keeps foreign-key actions active during the generated table rebuild.
-- Preserve each incoming reference separately so SET NULL can be reversed
-- without collecting an unbounded JSON array in one migration row.
INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at)
SELECT 'storage_cleanup',
       json_object('operation_id',id,'external_task_id',external_task_id),
       'migration:multipart-task-kinds:reference:' || id,
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM lti_material_operations
WHERE external_task_id IS NOT NULL
ON CONFLICT(dedupe_key) DO NOTHING;
