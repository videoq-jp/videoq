-- drizzle-kit:custom
-- Preserve the association that exists at migration time. Historical questions
-- whose source was already removed retain their current course-wide policy.
UPDATE course_questions SET source_video_id=video_id WHERE video_id IS NOT NULL;
