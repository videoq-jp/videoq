import { and, eq, inArray } from 'drizzle-orm';
import type { Bindings } from '../../types/bindings';
import { withDb } from '../../db/pool';
import { videos } from '../../db/schema';

/** Authorization needs metadata only; never load every transcript in a playlist. */
export async function classroomVideoSummaries(env: Bindings, ownerUserId: string, videoIds: number[]) {
  if (!videoIds.length) return [];
  return withDb(env, db => db.select({ id: videos.id, title: videos.title }).from(videos).where(and(
    eq(videos.userId, ownerUserId), eq(videos.status, 'completed'), inArray(videos.id, videoIds),
  )));
}

export async function classroomPlaybackVideo(env: Bindings, ownerUserId: string, videoId: number) {
  const [video] = await withDb(env, db => db.select({ file: videos.file, sourceType: videos.sourceType, youtubeId: videos.youtubeVideoId,
    title: videos.title, description: videos.description }).from(videos).where(and(
    eq(videos.id, videoId), eq(videos.userId, ownerUserId), eq(videos.status, 'completed'),
  )).limit(1));
  return video ?? null;
}
