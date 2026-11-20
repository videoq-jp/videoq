import type { LtiSessionProof } from './lti-session-proof';
export type SavedCourseHistory = {
  scopeVideoIds: number[];
  turns: Array<{ id: string; logId: number; question: string }>;
};
export type CourseHistoryScope={sessionProof?:LtiSessionProof;registrationId:string;subjectHash:string;courseId:number;contextId?:string};
export type CourseHistoryTurn={id:string;logId:number;question:string};
export type CourseHistoryRecord={payload:unknown;logs:Array<{id:number;answer:unknown;feedback:string|null}>};
