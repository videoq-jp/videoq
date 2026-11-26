import type { LtiSessionProof } from './lti-session-proof';
export type CourseReportScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string;
  sessionProof: LtiSessionProof;
  readable: { videoId: number; generation: number; resourceLinkId: string }[];
};
export type { ReportDay, ReportPeriod } from '../domain/learning/course-report';
