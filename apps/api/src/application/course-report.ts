import type { LtiSessionProof } from './lti-session-proof';
export type CourseReportScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string;
  sessionProof: LtiSessionProof;
  readable: { videoId: number; generation: number; resourceLinkId: string }[];
};
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
