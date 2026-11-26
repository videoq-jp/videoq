/** Course names use the public API's 255 UTF-16 code-unit bound after trimming. */
export const MAX_COURSE_NAME_LENGTH = 255;
export type CourseNameResult = { name: string } | { error: string };
export function normalizeCourseName(value: string): CourseNameResult {
  const name = value.trim();
  if (!name) return { error: 'Course name cannot be empty.' };
  if (name.length > MAX_COURSE_NAME_LENGTH) return { error: `Course name must be at most ${MAX_COURSE_NAME_LENGTH} characters.` };
  return { name };
}
