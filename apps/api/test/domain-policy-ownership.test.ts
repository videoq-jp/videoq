import { expect, it } from 'vitest';
import { validReportDay, validReportPeriod } from '../src/domain/learning/course-report';
import { materialCapabilities } from '../src/domain/media/material-management';
import { materialMutationKind, MaterialMutationError } from '../src/domain/media/material-mutation';
import { materialMutationKind as applicationMutationKind } from '../src/application/material-mutation';
import { checkTagMutation, CourseTagConflict } from '../src/domain/learning/course-tags';
import { checkTagMutation as applicationTagMutation } from '../src/features/course-tags/policy';
import { checkedFacts, SkillPolicyError } from '../src/domain/skills/policy';
import { checkedFacts as applicationFacts } from '../src/features/skills/core';
import { ApplicationError } from '../src/application/errors';

it('owns calendar validity and the exclusive 366-day report boundary in learning', () => {
  expect(validReportDay('2024-02-29')).toBe(true);
  expect(validReportDay('2025-02-29')).toBe(false);
  expect(validReportDay('0000-01-01')).toBe(false);
  expect(validReportPeriod({ action: 'summary', from: '2024-01-01', to: '2024-12-31' })).toBe(true);
  expect(validReportPeriod({ action: 'summary', from: '2024-01-01', to: '2025-01-01' })).toBe(false);
  expect(validReportPeriod({ action: 'summary', from: '2024-01-02', to: '2024-01-01' })).toBe(false);
});

it.each(['pending', 'uploading', 'indexing', 'completed', 'error'])('keeps offered material actions consistent with processing state %s', status => {
  const access = materialCapabilities(status, false, true);
  for (const action of ['update', 'reindex', 'retry'] as const) {
    const offered = action === 'update' ? access.canEdit : action === 'reindex' ? access.canReindex : access.canRetry;
    const decide = () => materialMutationKind({ action, videoId: 1, operationId: 'operation', revision: 'revision', fields: {} }, status);
    if (offered) expect(decide).not.toThrow();
    else expect(decide).toThrow(MaterialMutationError);
  }
  expect(materialCapabilities(status, true, false).canRetry).toBe(status === 'indexing');
});

it('maps material domain rejection to the existing application conflict', () => {
  const input = { action: 'reindex' as const, videoId: 1, operationId: 'operation', revision: 'revision' };
  expect(() => materialMutationKind(input, 'pending')).toThrow(MaterialMutationError);
  expect(() => applicationMutationKind(input, 'pending')).toThrow(ApplicationError);
  expect(() => applicationMutationKind(input, 'pending')).toThrow(expect.objectContaining({ kind: 'conflict', code: 'CONFLICT' }));
});

it('maps asynchronous tag revision rejection without leaking a domain exception', async () => {
  const scope = { installationId: 'installation', contextId: 'context', ownerUserId: 'owner', actorKey: 'a'.repeat(64),
    courseId: 1, readableVideoIds: [1], manage: true, management: [{ videoId: 1, resourceLinkId: 'resource', generation: 1 }] };
  const input = { action: 'assign' as const, operationId: 'operation', videoId: 1, tagIds: [], revision: 'old' };
  const digest = async () => 'new';
  await expect(checkTagMutation(scope, input, [], digest)).rejects.toBeInstanceOf(CourseTagConflict);
  await expect(applicationTagMutation(scope, input, [], digest)).rejects.toMatchObject({ kind: 'conflict', code: 'CONFLICT' });
});

it('owns source grounding in skills while the application translates validation errors', () => {
  const facts = { facts: [{ kind: 'principle' as const, claim: 'claim', appliesWhen: 'always', evidence: [{ cueId: 'missing', quote: 'quote' }] }] };
  expect(() => checkedFacts(facts, [], 0)).toThrow(SkillPolicyError);
  expect(() => applicationFacts(facts, [], 0)).toThrow(expect.objectContaining({ kind: 'validation', code: 'VALIDATION_ERROR' }));
});
