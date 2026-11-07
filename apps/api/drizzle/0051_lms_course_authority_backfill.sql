-- drizzle-kit:custom
-- Preserve Moodle authority even after a later installation disconnect.
UPDATE video_courses
SET managed_by_lms = true
WHERE EXISTS (
  SELECT 1 FROM lms_courses WHERE lms_courses.course_id = video_courses.id
);
