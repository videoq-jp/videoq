import type { CourseHistoryScope, CourseHistoryTurn, CourseHistoryRecord } from '../../application/course-history';
export type { CourseHistoryScope, CourseHistoryTurn, CourseHistoryRecord } from '../../application/course-history';
export interface CourseHistoryRepository{
 append(scope:CourseHistoryScope,id:string,turn:CourseHistoryTurn,allowed:number[]|undefined,expiresAt:Date):Promise<void>;
 read(scope:CourseHistoryScope,id:string,ownerUserId:string):Promise<CourseHistoryRecord|null>;
}
