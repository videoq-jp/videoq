import { forbidden } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import type { CourseReportScope, ReportPeriod } from '../../application/course-report';

export function validReportDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !value.startsWith('0000-') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validReportPeriod(value: unknown): value is ReportPeriod {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ['action', 'from', 'to'].includes(key)) && input.action === 'summary'
    && typeof input.from === 'string' && typeof input.to === 'string'
    && validReportDay(input.from) && validReportDay(input.to)
    && input.to >= input.from && Date.parse(input.to) - Date.parse(input.from) < 366 * 86400000;
}
export const reportDenied = () => forbidden('Course reports are unavailable.');
export function checkCourseReport(scope: CourseReportScope, input: ReportPeriod): void {
  createLtiSessionProof(scope.sessionProof, scope.sessionProof.sessionHash);
  if (scope.readable.length > 1000 || scope.sessionProof.registrationId !== 'db:' + scope.installationId || !validReportPeriod(input)
    || !Number.isSafeInteger(scope.courseId) || scope.courseId <= 0 || scope.readable.some(resource =>
      !Number.isSafeInteger(resource.videoId) || resource.videoId <= 0 || !Number.isSafeInteger(resource.generation)
      || resource.generation <= 0 || typeof resource.resourceLinkId !== 'string')) throw reportDenied();
}
