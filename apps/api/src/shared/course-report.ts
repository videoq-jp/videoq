import {z} from 'zod';
import {ApiError} from './errors';
import {ltiSessionProof} from './lti-session-proof';
import type {CourseReportScope,ReportPeriod} from '../persistence/contracts/course-report-repository';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return !value.startsWith('0000-') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const courseReportInput = z.object({ action: z.literal('summary'), from: day, to: day }).strict()
  .refine(value => value.to >= value.from && Date.parse(value.to) - Date.parse(value.from) < 366 * 86400000);

export const reportDenied=()=>new ApiError(403,'FORBIDDEN','Course reports are unavailable.');
export function checkCourseReport(scope:CourseReportScope,input:ReportPeriod):void{
 ltiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);
 if(scope.readable.length>1000||scope.sessionProof.registrationId!=='db:'+scope.installationId||!courseReportInput.safeParse(input).success||
  !Number.isSafeInteger(scope.courseId)||scope.courseId<=0||scope.readable.some(r=>!Number.isSafeInteger(r.videoId)||r.videoId<=0||!Number.isSafeInteger(r.generation)||r.generation<=0||typeof r.resourceLinkId!=='string'))throw reportDenied();
}
