import { expect, it, vi } from 'vitest';
import { createMediaService, createMediaRedirectService } from '../src/features/media/core';

it.each([null, false, true])('preserves access outcomes for %s', async access => {
  const repository = { getPathAccess: vi.fn().mockResolvedValue(access) };
  const result = await createMediaService(repository).authorizeMediaPath('video.mp4', { userId: 'owner' });
  expect(result).toEqual(access === null ? { invalidShare: true } : access ? { ok: true, objectKey: 'media/video.mp4' } : { notFound: true });
  expect(repository.getPathAccess).toHaveBeenCalledWith('video.mp4', { userId: 'owner' });
});

it('resolves fallback URLs only for external storage', async () => {
  const resolveFileUrl = vi.fn().mockResolvedValue('https://storage.example/video');
  await expect(createMediaRedirectService({ externalStorage: false, resolveFileUrl }).fallbackRedirectUrl('video')).resolves.toBeNull();
  expect(resolveFileUrl).not.toHaveBeenCalled();
  const service = createMediaRedirectService({ externalStorage: true, resolveFileUrl });
  await expect(service.fallbackRedirectUrl('video')).resolves.toBe('https://storage.example/video');
  resolveFileUrl.mockResolvedValue('/api/media/video');
  await expect(service.fallbackRedirectUrl('video')).resolves.toBeNull();
});
