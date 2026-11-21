import {
  evidenceVideoSelected,
  inlineTranscript,
  visualEvidenceReady,
} from "../../application/content-read";
import { learningVideoAllowed } from "../../application/media-eligibility";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import {
  contentDrizzleLogic,
  visualReadDrizzleLogic,
} from "../content-read-policy-sql";
import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { videos, videoVisualRuns } from "../../db/schema/sqlite";
import type { VideoEvidenceRepository } from "../contracts/video-evidence-repository";

export function createD1VideoEvidenceRepository(
  database: D1Database,
): VideoEvidenceRepository {
  const db = createD1Connection(database);
  return {
    async getEvidence(scope, videoId) {
      if (!evidenceVideoSelected(scope.videoIds, videoId)) return null;
      const transcript = inlineTranscript(
        sql`${videos.transcript}`,
        sql`length(CAST(${videos.transcript} AS BLOB))`,
        contentDrizzleLogic,
      );
      const visual = visualEvidenceReady(
        sql`${videoVisualRuns.fileKey}=${videos.file}`,
        sql`${videoVisualRuns.status}`,
        visualReadDrizzleLogic,
      );
      const [row] = await db
        .select({
          id: videos.id,
          title: videos.title,
          sourceType: videos.sourceType,
          fileKey: videos.file,
          visualRunId: sql<string | null>`(${db
            .select({ runId: videoVisualRuns.runId })
            .from(videoVisualRuns)
            .where(and(eq(videoVisualRuns.videoId, videos.id), visual))})`,
          visualManifestVersion: sql<string | null>`(${db
            .select({ publicationVersion: videoVisualRuns.publicationVersion })
            .from(videoVisualRuns)
            .where(and(eq(videoVisualRuns.videoId, videos.id), visual))})`,
          transcript: sql<string | null>`${transcript.value}`,
          transcriptTooLarge: sql<number>`${transcript.tooLarge}`.mapWith(
            Boolean,
          ),
        })
        .from(videos)
        .where(
          and(
            eq(videos.id, videoId),
            learningVideoAllowed(
              eq(videos.userId, scope.ownerUserId),
              videos.status,
              mediaDrizzleLogic,
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
