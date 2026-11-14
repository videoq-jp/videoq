import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { videos } from "../../db/schema/sqlite";
import type { VideoEvidenceRepository } from "../contracts/video-evidence-repository";

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export function createD1VideoEvidenceRepository(database: D1Database): VideoEvidenceRepository {
  const db = createD1Connection(database);
  return {
    async getEvidence(scope, videoId) {
      if (!scope.videoIds.includes(videoId)) return null;
      const [row] = await db.select({ id: videos.id, title: videos.title, sourceType: videos.sourceType, fileKey: videos.file,
        visualRunId: sql<string | null>`(SELECT r.run_id FROM video_visual_runs r WHERE r.video_id=${videos.id} AND r.file_key=${videos.file} AND r.status='ready')`,
        visualManifestVersion: sql<string | null>`(SELECT r.publication_version FROM video_visual_runs r WHERE r.video_id=${videos.id} AND r.file_key=${videos.file} AND r.status='ready')`,
        transcript: sql<string | null>`CASE WHEN length(CAST(${videos.transcript} AS BLOB)) <= ${MAX_TRANSCRIPT_BYTES} THEN ${videos.transcript} ELSE NULL END`,
        transcriptTooLarge: sql<number>`coalesce(length(CAST(${videos.transcript} AS BLOB)) > ${MAX_TRANSCRIPT_BYTES},0)`.mapWith(Boolean),
      }).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, scope.ownerUserId), eq(videos.status, "completed"))).limit(1);
      return row ?? null;
    },
  };
}
