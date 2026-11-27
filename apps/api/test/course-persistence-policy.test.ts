import { expect, it } from 'vitest';
import { retainedCourseHistory, courseHistoryScopeIds, courseHistoryAttribution } from '../src/domain/learning/course-history';
import { reportMediaAllowed, reportGrantMatches, reportLogAllowed, courseReportVideoIds } from '../src/domain/learning/course-report';
import { checkTagMutation, assertTagOperationIdentity, assertTagOperationAvailable, assertTagCatalogSize, assignmentRevision } from '../src/features/course-tags/policy';
import type { CourseTagScope, CourseTag } from '../src/application/course-tags';

const booleanLogic = { and: (...values: boolean[]) => values.every(Boolean) };
it('retains history only while live, structurally valid and wholly inside the current scope', () => {
  const facts = { live: true, scopeArray: true, turnsArray: true, scopeCompatible: true };
  const prior = [{ logId: 1 }], empty: typeof prior = [];
  const logic = { ...booleanLogic, choose: (condition: boolean, yes: typeof prior, no: typeof prior) => condition ? yes : no };
  expect(retainedCourseHistory(facts, prior, empty, logic)).toBe(prior);
  for (const key of Object.keys(facts) as Array<keyof typeof facts>)
    expect(retainedCourseHistory({ ...facts, [key]: false }, prior, empty, logic)).toBe(empty);
  // SQL UNKNOWN does not retain a prior context, just like CASE WHEN.
  expect(retainedCourseHistory({ ...facts, live: null }, prior, empty, {
    and: (...values: Array<boolean | null>) => values.every(value => value === true),
    choose: (condition: boolean | null, yes, no) => condition === true ? yes : no,
  })).toBe(empty);
});

it('normalizes scope IDs without mutating input and preserves attribution context semantics', () => {
  const ids = [9, 2, 9, 1];
  expect(courseHistoryScopeIds(ids)).toEqual([1, 2, 9]);expect(courseReportVideoIds(ids)).toEqual([1, 2, 9]);
  expect(ids).toEqual([9, 2, 9, 1]);
  const scope = { registrationId: 'school', subjectHash: 'learner', courseId: 2, contextId: '' };
  expect(courseHistoryAttribution(scope)).toEqual({ registrationId: 'school', subjectHash: 'learner', courseId: 2 });
  expect(courseHistoryAttribution({ ...scope, contextId: 'context' })).toMatchObject({ contextId: 'context' });
});

it('requires current completed owned managed media and the entire resource grant', () => {
  for (let mask = 0; mask < 8; mask++) {
    const flags = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)] as const;
    expect(reportMediaAllowed(flags[0], flags[1], flags[2] ? 'completed' : 'indexing', { ...booleanLogic, statusIs: (status, expected) => status === expected })).toBe(mask === 7);
    expect(reportGrantMatches(...flags, booleanLogic)).toBe(mask === 7);
  }
});

it('requires report provenance scope and every source to be readable', () => {
  const facts = { originalNonempty: true, originalReadable: true, responseObject: true, sourcesArray: true, allSourcesReadable: true };
  expect(reportLogAllowed(facts, booleanLogic)).toBe(true);
  for (const key of Object.keys(facts) as Array<keyof typeof facts>)
    expect(reportLogAllowed({ ...facts, [key]: false }, booleanLogic)).toBe(false);
});

const scope: CourseTagScope = { installationId: 'school', contextId: 'context', courseId: 1, ownerUserId: 'owner', actorKey: 'actor',
  readableVideoIds: [1], manage: true, management: [{ videoId: 1, generation: 1, resourceLinkId: 'entry' }] };
const tag: CourseTag = { id: 'tag', name: 'Concept', color: 'blue', revision: 'current', video_ids: ['1'] };
const digest = async (value: string) => value;
it('protects tag revisions and managed resources before changing assignments or vocabulary', async () => {
  const edit = { action: 'update' as const, id: 'tag', revision: 'current', name: 'Edited', color: 'blue' as const, operationId: 'operation' };
  await expect(checkTagMutation(scope, edit, [tag], digest)).resolves.toBeUndefined();
  await expect(checkTagMutation(scope, { ...edit, revision: 'old' }, [tag], digest)).rejects.toMatchObject({ kind: 'conflict' });
  await expect(checkTagMutation(scope, edit, [{ ...tag, video_ids: ['1', '2'] }], digest)).rejects.toMatchObject({ kind: 'forbidden' });
  await expect(checkTagMutation(scope, { ...edit, id: 'unknown' }, [tag], digest)).rejects.toMatchObject({ kind: 'forbidden' });
  const assign = { action: 'assign' as const, operationId: 'operation', videoId: 1, tagIds: ['tag'], revision: await assignmentRevision(scope, 1, ['tag'], digest) };
  await expect(checkTagMutation(scope, assign, [tag], digest)).resolves.toBeUndefined();
  await expect(checkTagMutation(scope, { ...assign, tagIds: ['hidden'], revision: 'stale' }, [tag], digest)).rejects.toMatchObject({ kind: 'forbidden' });
  await expect(checkTagMutation(scope, { ...assign, videoId: 2 }, [tag], digest)).rejects.toMatchObject({ kind: 'forbidden' });
  await expect(checkTagMutation(scope, { ...assign, revision: 'stale' }, [tag], digest)).rejects.toMatchObject({ kind: 'conflict' });
});

it('allows a full catalog to be read but refuses creation, collisions and retired operations', async () => {
  expect(() => assertTagCatalogSize(200)).not.toThrow();
  expect(() => assertTagCatalogSize(201)).toThrow('Too many course tags');
  await expect(checkTagMutation(scope, { action: 'create', name: 'New', color: 'blue', operationId: 'operation' },
    Array.from({ length: 200 }, () => tag), digest)).rejects.toMatchObject({ kind: 'too_large' });
  for (const matches of [[false, true, true], [true, false, true], [true, true, false]])
    expect(() => assertTagOperationIdentity(matches[0], matches[1], matches[2])).toThrow('Tags changed');
  expect(() => assertTagOperationAvailable(false)).toThrow('operation is no longer available');
});
