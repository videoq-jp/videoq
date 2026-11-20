import { z } from 'zod';
import { asApiError } from './errors';
import * as policy from '../features/course-reports/policy';
import type { CourseReportScope, ReportPeriod } from '../persistence/contracts/course-report-repository';
const day = z.string().refine(policy.validReportDay);
export const courseReportInput = z.object({ action: z.literal('summary'), from: day, to: day }).strict().refine(policy.validReportPeriod);
export const reportDenied = () => asApiError(policy.reportDenied())!;
export function checkCourseReport(scope: CourseReportScope, input: ReportPeriod): void {
  try { policy.checkCourseReport(scope, input); }
  catch (error) { throw asApiError(error) ?? error; }
}
