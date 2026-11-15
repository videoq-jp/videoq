import {z} from 'zod';
import {ApiError} from './errors';
import {ltiSessionProof} from './lti-session-proof';
import type {CourseHistoryScope} from '../persistence/contracts/course-history-repository';
export const savedCourseHistory=z.object({scopeVideoIds:z.array(z.number().int().positive().safe()).max(1000),turns:z.array(z.object({
 id:z.string().regex(/^[a-f0-9]{32}$/),logId:z.number().int().positive().safe(),question:z.string().max(4000),
})).max(50)});
export function checkHistoryScope(scope:CourseHistoryScope):void{
 if(scope.sessionProof){
  ltiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);
  if(scope.registrationId!==scope.sessionProof.registrationId||scope.subjectHash!==scope.sessionProof.subjectHash)throw historyDenied();
 }
}
export const historyDenied=()=>new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
