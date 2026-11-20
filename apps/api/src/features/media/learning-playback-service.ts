import type { LearningMediaRepository } from '../../persistence/contracts/learning-media-repository';

export interface LearningPlaybackDependencies {
  playback: LearningMediaRepository['playback'];
  fileUrl(key: string): Promise<string | null>;
}
export type LearningPlaybackScope = {
  course?: { userId: string } | null;
  current?: { videos: { videoId: number }[] } | null;
};

/** Metadata is fetched only for a currently authorized video and its course owner. */
export async function learningPlayback(deps: LearningPlaybackDependencies, scope: LearningPlaybackScope, videoId: number) {
  if (!scope.course || !scope.current?.videos.some(item => item.videoId === videoId)) return null;
  const video = await deps.playback(scope.course.userId, videoId);
  if (!video) return null;
  if (video.sourceType === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(video.youtubeId)) {
    return { kind: 'youtube' as const, title: video.title, description: video.description,
      url: `https://www.youtube-nocookie.com/embed/${video.youtubeId}` };
  }
  const url = await deps.fileUrl(video.file);
  if (!url?.startsWith('https://')) return null;
  return { kind: 'file' as const, title: video.title, description: video.description, url };
}
