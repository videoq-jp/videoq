/** Verified identity data. Signature, endpoint and body verification belong to the adapter. */
export type NativeLearningClaims = {
  deploymentId: string; subject: string; contextId: string; resourceLinkId: string;
  author?: { name: string; email: string };
  sessionId: string; sessionExpiresAt: number; exp: number; jti: string;
  accessProof?: string; locale: 'en' | 'ja';
};
export type LearningGrant = {
  transport?: 'native' | 'classroom';
  moodleAuthor?: { user_id: string; username: string; email: string };
  registrationId: string; registrationHash: string;
  deploymentId: string; contextId: string; resourceLinkId: string;
  locale: 'en' | 'ja'; scopeVideoIds?: number[]; serviceSubject?: string;
  accessProof?: { token: string; subject: string };
  courseId: number; videoId?: number; resourceGeneration?: number; subjectHash: string; roles: string[];
};
export type NativeSessionInput = {
  ownerUserId: string; grant: LearningGrant; sessionHash: string; markerHash: string;
  nonceHash: string; nonceExpiresAt: Date; expiresAt: Date;
};
export type NativeLearningRegistration = {
  id: string; issuer: string; clientId: string; materialsService?: unknown;
  resources: { deploymentId: string; contextId: string; resourceLinkId: string;
    courseId: number; videoId?: number; generation?: number }[];
};
export type LearningCourse = { id: number; userId: string; memberVideoIds: number[] };
export type NativeLearningAccess = {
  course?: LearningCourse; videos: { videoId: number }[]; managementVideos?: { videoId: number }[];
};
