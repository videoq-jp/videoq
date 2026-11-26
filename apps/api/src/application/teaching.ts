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

export type { TeachingConnectionBinding } from '../domain/lms/teaching';
