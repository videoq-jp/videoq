import { COURSE_HISTORY_MAX_TURNS } from '../application/course-history-append';
import {z} from 'zod';
import { asApiError } from './errors';
import * as policy from '../features/course-history/policy';
import type {CourseHistoryScope} from '../persistence/contracts/course-history-repository';
export const savedCourseHistory=z.object({scopeVideoIds:z.array(z.number().int().positive().safe()).max(1000),turns:z.array(z.object({
 id:z.string().regex(/^[a-f0-9]{32}$/),logId:z.number().int().positive().safe(),question:z.string().max(4000),
})).max(COURSE_HISTORY_MAX_TURNS)});
export function checkHistoryScope(scope: CourseHistoryScope): void {
  try { policy.checkHistoryScope(scope); }
  catch (error) { throw asApiError(error) ?? error; }
}
export const historyDenied = () => asApiError(policy.historyDenied())!;
