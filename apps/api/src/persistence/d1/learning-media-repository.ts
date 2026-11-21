import { and, eq, inArray } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { runD1Batch, type D1Query } from "../../db/d1/query-builders";
import { videos } from "../../db/schema/sqlite";
import { learningVideoAllowed } from "../../application/media-eligibility";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import type { LearningMediaRepository } from "../contracts/learning-media-repository";
export function createD1LearningMediaRepository(
  database: D1Database,
): LearningMediaRepository {
  const db = createD1Connection(database);
  const allowed = (ownerUserId: string) =>
    learningVideoAllowed(
      eq(videos.userId, ownerUserId),
      videos.status,
      mediaDrizzleLogic,
    );
  return {
    async summaries(ownerUserId, videoIds) {
      const ids = [...new Set(videoIds)],
        queries: D1Query[] = [];
      for (let offset = 0; offset < ids.length; offset += 80)
        queries.push(
          db
            .select({ id: videos.id, title: videos.title })
            .from(videos)
            .where(
              and(
                allowed(ownerUserId),
                inArray(videos.id, ids.slice(offset, offset + 80)),
              ),
            ),
        );
      const rows: { id: number; title: string }[] = [];
      for (let offset = 0; offset < queries.length; offset += 25) {
        const batch = await runD1Batch<{ id: number; title: string }>(
          database,
          queries.slice(offset, offset + 25),
        );
        rows.push(...batch.flatMap((result) => result.results));
      }
      return rows.sort((a, b) => a.id - b.id);
    },
    async playback(ownerUserId, videoId) {
      return (
        (await db
          .select({
            file: videos.file,
            sourceType: videos.sourceType,
            youtubeId: videos.youtubeVideoId,
            title: videos.title,
            description: videos.description,
          })
          .from(videos)
          .where(and(eq(videos.id, videoId), allowed(ownerUserId)))
          .get()) ?? null
      );
    },
  };
}
