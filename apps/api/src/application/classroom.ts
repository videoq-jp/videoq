export type ClassroomConfig = { toolOrigin: string };
export type ClassroomMaterial = { id: string; title: string; videoIds: number[] };
export type ClassroomCourse = { classroomCourseId: string; videoqCourseId: number; materials: ClassroomMaterial[] };
export type ClassroomLaunch = {
  courseId: string; itemId: string; itemType: 'courseWork' | 'announcements' | 'courseWorkMaterials';
  attachmentId?: string; addOnToken?: string; login_hint?: string; view: 'discovery' | 'teacher' | 'student';
};
export type ClassroomAccount = {
  subject: string; name?: string; email?: string; clientId: string;
  accessToken: string; refreshToken?: string; expiresAt: number;
};
export type ClassroomContext = { courseId: string; itemId: string;
  teacherContext?: Record<string, never>; studentContext?: { submissionId?: string } };
export type ClassroomAttachment = { id: string; title: string;
  teacherViewUri: { uri: string }; studentViewUri: { uri: string } };

export class ClassroomAccessDeniedError extends Error {}
