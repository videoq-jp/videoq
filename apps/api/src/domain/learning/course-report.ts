export type ReportDay = { date: string; questions: number; good: number; bad: number; none: number };
export type ReportPeriod={action:'summary';from:string;to:string};

export interface ReportLogic<Predicate> { and(...conditions: Predicate[]): Predicate; }

export function reportMediaAllowed<Status, Predicate>(owned: Predicate, managed: Predicate, status: Status,
  logic: ReportLogic<Predicate> & { statusIs(status: Status, expected: 'completed'): Predicate }): Predicate {
  return logic.and(owned, managed, logic.statusIs(status, 'completed'));
}

export function reportGrantMatches<Predicate>(videoMatches: Predicate, generationMatches: Predicate, linkMatches: Predicate,
  logic: ReportLogic<Predicate>): Predicate {
  return logic.and(videoMatches, generationMatches, linkMatches);
}

/** A report may count a turn only while its entire original scope and all of
 * its citations remain readable. Empty citation arrays are allowed. */
export function reportLogAllowed<Predicate>(facts: {
  originalNonempty: Predicate; originalReadable: Predicate;
  responseObject: Predicate; sourcesArray: Predicate; allSourcesReadable: Predicate;
}, logic: ReportLogic<Predicate>): Predicate {
  return logic.and(facts.originalNonempty, facts.originalReadable, facts.responseObject, facts.sourcesArray, facts.allSourcesReadable);
}

export function courseReportVideoIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

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
