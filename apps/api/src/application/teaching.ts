/** Transport-independent teaching connection input. */
export interface TeachingTicket {
  provider: 'moodle' | 'classroom';
  installationId: string;
  contextId: string;
  teacherSubject: string;
  teacherName: string;
  title: string;
  returnUrl: string;
  resourceLinkId?: string;
  classroomProof?: {
    accountEnvelope: string;
    launch: {
      courseId: string;
      itemId: string;
      itemType: 'courseWork' | 'announcements' | 'courseWorkMaterials';
      attachmentId?: string;
      addOnToken?: string;
      login_hint?: string;
      view: 'discovery' | 'teacher' | 'student';
    };
  };
}

export type TeachingConnectionBinding = { ownerUserId: string; teacherSubject: string; courseId: number };

/** Disconnecting a class does not relinquish its owner, teacher or chosen course. */
export function teachingConnectionConflicts(existing: TeachingConnectionBinding | null | undefined,
  ownerUserId: string, teacherSubject: string, selectedCourseId?: number): boolean {
  return Boolean(existing && (existing.ownerUserId !== ownerUserId || existing.teacherSubject !== teacherSubject
    || selectedCourseId !== undefined && existing.courseId !== selectedCourseId));
}

export function teachingInstallationRequired(provider: TeachingTicket['provider']): boolean {
  return provider === 'moodle';
}

export function teachingResourceLinkAllowed(ticket: Pick<TeachingTicket, 'provider' | 'resourceLinkId'>): boolean {
  return !teachingInstallationRequired(ticket.provider) || Boolean(ticket.resourceLinkId);
}

/** Reconnection may reuse its existing course; first connection needs a selection. */
export function selectTeachingCourse(existing: Pick<TeachingConnectionBinding, 'courseId'> | null | undefined,
  selectedCourseId?: number): number | null {
  const courseId = selectedCourseId ?? existing?.courseId;
  return courseId || null;
}
