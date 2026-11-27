export type TeachingProvider = 'moodle' | 'classroom';
export type TeachingConnectionBinding = { ownerUserId: string; teacherSubject: string; courseId: number };

/** Disconnecting a class does not relinquish its owner, teacher or chosen course. */
export function teachingConnectionConflicts(existing: TeachingConnectionBinding | null | undefined,
  ownerUserId: string, teacherSubject: string, selectedCourseId?: number): boolean {
  return Boolean(existing && (existing.ownerUserId !== ownerUserId || existing.teacherSubject !== teacherSubject
    || selectedCourseId !== undefined && existing.courseId !== selectedCourseId));
}

export function teachingInstallationRequired(provider: TeachingProvider): boolean {
  return provider === 'moodle';
}

export function teachingResourceLinkAllowed(ticket: { provider: TeachingProvider; resourceLinkId?: string }): boolean {
  return !teachingInstallationRequired(ticket.provider) || Boolean(ticket.resourceLinkId);
}

/** Reconnection may reuse its existing course; first connection needs a selection. */
export function selectTeachingCourse(existing: Pick<TeachingConnectionBinding, 'courseId'> | null | undefined,
  selectedCourseId?: number): number | null {
  const courseId = selectedCourseId ?? existing?.courseId;
  return courseId || null;
}
