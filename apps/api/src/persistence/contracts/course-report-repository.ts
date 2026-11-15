import type {LtiSessionProof} from '../../shared/lti-session-proof';
export type CourseReportScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string;
  sessionProof: LtiSessionProof;
  readable: { videoId: number; generation: number; resourceLinkId: string }[];
};
export type ReportDay = { date: string; questions: number; good: number; bad: number; none: number };
export type ReportPeriod={action:'summary';from:string;to:string};
export interface CourseReportRepository{summarize(scope:CourseReportScope,input:ReportPeriod,actorKey:string):Promise<ReportDay[]>;}
