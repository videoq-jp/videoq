import type {LtiSessionProof} from '../../shared/lti-session-proof';
export type CourseHistoryScope={sessionProof?:LtiSessionProof;registrationId:string;subjectHash:string;courseId:number;contextId?:string};
export type CourseHistoryTurn={id:string;logId:number;question:string};
export type CourseHistoryRecord={payload:unknown;logs:Array<{id:number;answer:unknown;feedback:string|null}>};
export interface CourseHistoryRepository{
 append(scope:CourseHistoryScope,id:string,turn:CourseHistoryTurn,allowed:number[]|undefined,expiresAt:Date):Promise<void>;
 read(scope:CourseHistoryScope,id:string,ownerUserId:string):Promise<CourseHistoryRecord|null>;
}
