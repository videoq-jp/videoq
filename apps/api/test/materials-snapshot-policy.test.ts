import { expect, it } from 'vitest';
import { materialsSnapshotIssues } from '../src/features/lms/materials-snapshot-policy';

function resource(externalId: string, kind?: 'course' | 'youtube', contextId = 'course') {
  return { externalId, manifest: { contextId, kind } };
}

it('accepts one course entry and 1000 mixed file/YouTube sources without treating omission as deletion', () => {
  expect(materialsSnapshotIssues({ contextId: 'course', resources: [resource('entry', 'course'),
    ...Array.from({ length: 1000 }, (_, index) => resource('video-' + index, index % 2 ? 'youtube' : undefined))] })).toEqual([]);
  expect(materialsSnapshotIssues({ contextId: 'course', resources: [] })).toEqual([]);
});

it('reports repeated identities and cross-context resources in source order, without normalizing opaque IDs', () => {
  expect(materialsSnapshotIssues({ contextId: 'course', resources: [resource('ID'), resource('id'), resource('ID'), resource('other', undefined, 'different')] }))
    .toEqual(['Duplicate or cross-context material', 'Duplicate or cross-context material']);
});

it.each([
  { resources: [resource('a', 'course'), resource('b', 'course')] },
  { resources: Array.from({ length: 1001 }, (_, index) => resource(String(index))) },
  { resources: Array.from({ length: 1001 }, (_, index) => resource(String(index), 'youtube')) },
])('rejects excess course entries or videos %#', ({ resources }) => {
  expect(materialsSnapshotIssues({ contextId: 'course', resources })).toEqual(['Too many course entries or materials']);
});

it('retains per-resource errors before the count violation', () => {
  expect(materialsSnapshotIssues({ contextId: 'course', resources: [resource('entry', 'course'), resource('entry', 'course', 'other')] }))
    .toEqual(['Duplicate or cross-context material', 'Too many course entries or materials']);
});
