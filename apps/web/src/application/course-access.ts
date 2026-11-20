/** Preserve legacy courses without an explicit role as manageable. */
export function canManageCourse(course: { access_role?: string } | null | undefined): boolean {
  return !!course && course.access_role !== 'member';
}

/** Shared visitors do not read or export the owner's course history. */
export function canReadCourseHistory(courseId: number | undefined, shareToken: string | undefined): boolean {
  return !!courseId && !shareToken;
}

/** The server orders owned courses first; joined courses cannot supply owner activity. */
export function firstOwnedCourse<Course extends { access_role?: string }>(courses: readonly Course[] | undefined): Course | null {
  const first = courses?.[0];
  return first?.access_role === 'owner' ? first : null;
}
