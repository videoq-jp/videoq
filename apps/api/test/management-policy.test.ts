import { expect, it, vi } from 'vitest';
import { tagCatalog, refineTagScope } from '../src/features/course-tags/policy';
import { checkMaterialManagement, materialView, type MaterialPolicyDependencies } from '../src/features/material-management/policy';
import type { CourseTagScope } from '../src/persistence/contracts/course-tag-repository';
import type { ManagedMaterialScope } from '../src/persistence/contracts/material-management-repository';
import { asApiError } from '../src/shared/errors';

const scope: CourseTagScope = { installationId: 'school', contextId: 'ctx', courseId: 1, ownerUserId: 'owner', actorKey: 'a'.repeat(64),
  readableVideoIds: [1], manage: true, management: [{ videoId: 2, resourceLinkId: 'video', generation: 3 }] };

it('keeps invisible video IDs out of tag views without granting edit rights over mixed tags', async () => {
  const result = await tagCatalog([
    { id: 'mixed', name: 'Mixed', color: 'gray', revision: 'r', video_ids: ['2', '3'] },
    { id: 'hidden', name: 'Hidden', color: 'gray', revision: 'r', video_ids: ['3'] },
    { id: 'empty', name: 'Empty', color: 'gray', revision: 'r', video_ids: [] },
  ], scope, async value => value);
  expect(result.tags.map(tag => ({ id: tag.id, videoIds: tag.videoIds, editable: tag.editable }))).toEqual([
    { id: 'mixed', videoIds: [2], editable: false }, { id: 'empty', videoIds: [], editable: true },
  ]);
  expect(result.videos.map(video => [video.videoId, video.editable])).toEqual([[1, false], [2, true]]);
  expect(refineTagScope(scope, [{ video_id: 2, resource_link_id: 'video', generation: 4, status: 'completed' }]).management).toEqual([]);
});

const materialScope: ManagedMaterialScope = { installationId: 'school', ownerUserId: 'owner', courseId: 1, contextId: 'ctx', resourceLinkId: 'video', videoId: 2, generation: 3, actorKey: 'a'.repeat(64) };
function dependencies(): MaterialPolicyDependencies {
  return { digest: async value => value, byteLength: value => value.length, validateTranscript: () => null, validTranscriptionMessage: () => false };
}
it('rejects oversized material data with an application failure that maps to HTTP 413', () => {
  const deps = dependencies();
  deps.byteLength = () => 40001;
  try {
    checkMaterialManagement(materialScope, { action: 'update', videoId: 2, operationId: 'op', revision: 'r', fields: { description: 'large' } }, deps);
    throw new Error('Expected size rejection');
  } catch (error) {
    expect(error).toMatchObject({ kind: 'too_large' });
    expect(asApiError(error)).toMatchObject({ status: 413, code: 'VALIDATION_ERROR' });
  }
});
it('never offers retry for an invalid or already committed transcription job', async () => {
  const deps = dependencies();
  const validate = vi.fn().mockReturnValue(true);
  deps.validTranscriptionMessage = validate;
  const video = { title: 'Video', description: '', transcript: '', status: 'error', file: 'video.mp4' };
  const completed = await materialView(materialScope, video, undefined, { id: 'job', message: {}, dead: false, status: 'completed' }, deps);
  expect(completed.canRetry).toBe(false);
  expect(validate).not.toHaveBeenCalled();
  validate.mockReturnValue(false);
  expect((await materialView(materialScope, video, undefined, { id: 'job', message: {}, dead: false, status: 'failed' }, deps)).canRetry).toBe(false);
});
