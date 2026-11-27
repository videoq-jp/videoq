import { forbidden } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import type { CourseReportScope, ReportPeriod } from '../../application/course-report';

import { validReportPeriod } from '../../domain/learning/course-report';
export const reportDenied = () => forbidden('Course reports are unavailable.');
export function checkCourseReport(scope: CourseReportScope, input: ReportPeriod): void {
  createLtiSessionProof(scope.sessionProof, scope.sessionProof.sessionHash);
  if (scope.readable.length > 1000 || scope.sessionProof.registrationId !== 'db:' + scope.installationId || !validReportPeriod(input)
    || !Number.isSafeInteger(scope.courseId) || scope.courseId <= 0 || scope.readable.some(resource =>
      !Number.isSafeInteger(resource.videoId) || resource.videoId <= 0 || !Number.isSafeInteger(resource.generation)
      || resource.generation <= 0 || typeof resource.resourceLinkId !== 'string')) throw reportDenied();
}
