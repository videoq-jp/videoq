import { expect, it, vi } from 'vitest';
import { learningPlayback, type LearningPlaybackDependencies } from '../src/features/media/learning-playback-service';

const scope = { course: { userId: 'owner' }, current: { videos: [{ videoId: 7 }] } };
const video = { file: 'private-key', sourceType: 'file', youtubeId: '', title: 'Lesson', description: 'Description' };
function dependencies() {
  return {
    playback: vi.fn<LearningPlaybackDependencies['playback']>().mockResolvedValue(video),
    fileUrl: vi.fn<LearningPlaybackDependencies['fileUrl']>().mockResolvedValue('https://storage.example/signed'),
  };
}

it.each([{}, { course: scope.course }, { current: scope.current }, { ...scope, current: { videos: [{ videoId: 8 }] } }])('does not read video metadata or sign URLs outside the current scope %#', async access => {
    const deps = dependencies();
    expect(await learningPlayback(deps, access, 7)).toBeNull();
    expect(deps.playback).not.toHaveBeenCalled();
    expect(deps.fileUrl).not.toHaveBeenCalled();
  });

it('reads only the requested video under the authorized course owner', async () => {
  const deps = dependencies();
  expect(await learningPlayback(deps, scope, 7)).toEqual({ kind: 'file', title: video.title, description: video.description, url: 'https://storage.example/signed' });
  expect(deps.playback).toHaveBeenCalledExactlyOnceWith('owner', 7);
  expect(deps.fileUrl).toHaveBeenCalledExactlyOnceWith('private-key');
});

it('returns the privacy-enhanced YouTube embed without signing a storage URL', async () => {
  const deps = dependencies();
  deps.playback.mockResolvedValue({ ...video, sourceType: 'youtube', youtubeId: 'abcdefghijk' });
  expect(await learningPlayback(deps, scope, 7)).toEqual({ kind: 'youtube', title: video.title, description: video.description, url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' });
  expect(deps.fileUrl).not.toHaveBeenCalled();
});

it('retains file fallback for a source with an invalid YouTube identity', async () => {
  const deps = dependencies();
  deps.playback.mockResolvedValue({ ...video, sourceType: 'youtube', youtubeId: 'invalid/id?' });
  expect(await learningPlayback(deps, scope, 7)).toMatchObject({ kind: 'file', url: 'https://storage.example/signed' });
});

it.each([null, '', 'http://storage.example/video', '/private/video', 'javascript:alert(1)'])('denies an unavailable or non-HTTPS storage URL %s', async url => {
  const deps = dependencies();
  deps.fileUrl.mockResolvedValue(url);
  expect(await learningPlayback(deps, scope, 7)).toBeNull();
});

it('does not resolve storage when the authorized video no longer exists', async () => {
  const deps = dependencies();
  deps.playback.mockResolvedValue(null);
  expect(await learningPlayback(deps, scope, 7)).toBeNull();
  expect(deps.fileUrl).not.toHaveBeenCalled();
});

it.each(['playback', 'fileUrl'] as const)('preserves %s failures for transport error handling', async stage => {
  const deps = dependencies(), error = new Error(stage + ' unavailable');
  deps[stage].mockRejectedValue(error);
  await expect(learningPlayback(deps, scope, 7)).rejects.toBe(error);
  expect(deps.playback).toHaveBeenCalledOnce();
  expect(deps.fileUrl).toHaveBeenCalledTimes(stage === 'fileUrl' ? 1 : 0);
});
