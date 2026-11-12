-- drizzle-kit:custom
-- Preserve source authority independently of revocable installation mappings.
-- Scope backfill to the recorded account owner; never relabel another account.
UPDATE videos v SET managed_by_lms = true
 WHERE EXISTS (SELECT 1 FROM lms_resources r JOIN lms_installations i ON i.id=r.installation_id
                WHERE r.video_id=v.id AND i.owner_user_id=v.user_id)
    OR EXISTS (SELECT 1 FROM video_course_members m JOIN video_courses c ON c.id=m.course_id
                WHERE m.video_id=v.id AND c.managed_by_lms=true AND c.user_id=v.user_id);
--> statement-breakpoint
-- A legacy independent course may already contain a protected video. Retain
-- this restriction after detaching/deleting that video: saved answers, model
-- memory and Q&A may still include it. This does not make its metadata LMS-owned.
WITH protected_videos AS (
  SELECT id::text AS id FROM videos WHERE managed_by_lms=true
), affected_courses AS (
  SELECT m.course_id FROM video_course_members m JOIN protected_videos v ON v.id=m.video_id::text
  UNION
  SELECT l.course_id FROM chat_logs l
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.response->'sources')='array'
      THEN l.response->'sources' ELSE '[]'::jsonb END) source
    JOIN protected_videos v ON v.id=source->>'video_id'
  UNION
  SELECT c.course_id FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.response->'sources')='array'
      THEN t.response->'sources' ELSE '[]'::jsonb END) source
    JOIN protected_videos v ON v.id=source->>'video_id'
  UNION
  SELECT q.course_id FROM course_questions q JOIN protected_videos v ON v.id=q.source_video_id::text
)
UPDATE video_courses c SET native_access_disabled = true
 WHERE c.managed_by_lms=true OR c.id IN (SELECT course_id FROM affected_courses);
