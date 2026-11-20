import type { LearningCourse, LearningGrant } from './native-learning';

export type CoursePermissions = {
  manageContent: boolean; manageOwnHistory: boolean; viewTranscript: boolean; viewReports?: boolean;
  viewQa: boolean; postQa: boolean; voteQa: boolean; deleteOwnQa: boolean; moderateQa: boolean; instructorQa: boolean;
};
export const deniedCoursePermissions: CoursePermissions = Object.freeze({
  manageContent: false, manageOwnHistory: false, viewTranscript: false,
  viewQa: false, postQa: false, voteQa: false, deleteOwnQa: false, moderateQa: false, instructorQa: false,
});
export type CourseAuthorityResponse = {
  contextId: string; resourceLinkId: string; permissions?: CoursePermissions; courseEntry?: { generation: number };
  resources: Array<{ resourceLinkId: string; lesson: string; title: string; generation?: number;
    learning?: boolean; management?: { generation: number } }>;
};
export type CourseVideo = { videoId: number; lesson: string; title: string; sourceGeneration?: number; management?: { generation: number } };
export type CourseAccess = { courseTitle?: string; ownerHistory?: boolean; course?: LearningCourse;
  videos: CourseVideo[]; managementVideos?: CourseVideo[]; materialOrder?: number[]; permissions: CoursePermissions };
export type CourseGrant = Pick<LearningGrant, 'deploymentId' | 'contextId' | 'resourceLinkId' | 'courseId' | 'accessProof' | 'serviceSubject' | 'resourceGeneration'>;
export type CourseAccessRegistration = { id: string; resources: Array<{
  deploymentId: string; contextId: string; resourceLinkId: string; courseId: number;
  videoId?: number; generation?: number; sourceGeneration?: number; learningAvailable?: boolean; kind?: 'course' | 'linked';
}> };
