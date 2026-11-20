import { expect, it, vi } from 'vitest';
import { createSceneSearchService } from '../src/features/evidence/scene-search-service';
import { createCourseInfoService } from '../src/features/evidence/course-info-service';
import type { SceneHit } from '../src/persistence/contracts/scene-search';

it('reserves concurrent search calls before awaiting providers and ignores invalid scope selections', async () => {
  const execute = createSceneSearchService([1]);
  let release!: (hits: SceneHit[]) => void;
  const waiting = new Promise<SceneHit[]>(resolve => { release = resolve; });
  const deps = { checkCancelled: vi.fn(), search: vi.fn().mockReturnValue(waiting), reportProgress: vi.fn().mockResolvedValue(undefined) };
  expect(await execute({ query: 'outside', video_ids: [2] }, deps)).toContain('Invalid video_ids');
  expect(deps.search).not.toHaveBeenCalled();
  const requests = Array.from({ length: 3 }, () => execute({ query: 'question', video_ids: null }, deps));
  expect(await execute({ query: 'fourth', video_ids: null }, deps)).toContain('Search limit reached');
  release([]);
  await Promise.all(requests);
  expect(deps.search).toHaveBeenCalledTimes(3);
  expect(deps.reportProgress.mock.calls.filter(([event]) => 'searching' in event).map(([event]) => event.searchId)).toEqual([1, 2, 3]);
});
it('checks cancellation after the provider returns before publishing completed-search progress', async () => {
  const execute = createSceneSearchService([1]);
  const reportProgress = vi.fn().mockResolvedValue(undefined);
  let cancelled = false;
  await expect(execute({ query: 'question', video_ids: [1] }, {
    checkCancelled() { if (cancelled) throw new Error('cancelled'); },
    async search() { cancelled = true; return []; }, reportProgress,
  })).rejects.toThrow('cancelled');
  expect(reportProgress).toHaveBeenCalledTimes(1);
});
it('projects only public course metadata and does not offer a continuation after an empty page', async () => {
  const stored = { name: 'Course', description: 'description', video_count: 50, share_slug: 'secret', userId: 'private',
    videos: [{ id: 1, title: 'Video', description: 'video', order: 1, status: 'completed' as const, file: 'signed-private-url' }] };
  const load = vi.fn().mockResolvedValue(stored);
  const execute = createCourseInfoService(load);
  const result = await execute({ video_limit: 20, video_offset: 0 });
  expect(result).toMatchObject({ videos_meta: { next_offset: 1, has_more: true } });
  expect(JSON.stringify(result)).not.toMatch(/secret|private|signed/);
  load.mockResolvedValue({ ...stored, videos: [] });
  expect(await execute({ video_limit: 20, video_offset: 50 })).toMatchObject({ videos_meta: { next_offset: null, has_more: false } });
});
