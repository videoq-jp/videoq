import type { ReportLogic } from '../application/course-report';

/** Expressions and JSON membership codecs are owned by each database adapter. */
export const reportStringLogic: ReportLogic<string> & { statusIs(status: string, expected: 'completed'): string } = {
  statusIs: (status, expected) => `${status}='${expected}'`,
  and: (...conditions) => conditions.map(condition => `(${condition})`).join(' AND '),
};
