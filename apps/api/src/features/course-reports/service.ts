import { checkCourseReport } from './policy';
import type { LtiSessionProof } from '../../application/lti-session-proof';
import type { CourseReportRepository, CourseReportScope, ReportPeriod } from '../../persistence/contracts/course-report-repository';

export async function summarizeCourseReport(deps: {
  repository(): Promise<CourseReportRepository>; actorKey(proof: LtiSessionProof): Promise<string>;
}, scope: CourseReportScope, input: ReportPeriod) {
  checkCourseReport(scope, input);
  const days = await (await deps.repository()).summarize(scope, input, await deps.actorKey(scope.sessionProof));
  const totals = days.reduce((sum, row) => ({ questions: sum.questions + row.questions, good: sum.good + row.good,
    bad: sum.bad + row.bad, none: sum.none + row.none }), { questions: 0, good: 0, bad: 0, none: 0 });
  return { period: { from: input.from, to: input.to, timezone: 'UTC' as const }, totals, days,
    coverage: 'verified-moodle-resource-scope' as const };
}
