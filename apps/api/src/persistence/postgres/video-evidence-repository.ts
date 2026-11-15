import type { EvidenceScope, VideoEvidenceRepository } from "../contracts/video-evidence-repository";
import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { videos } from "../../db/schema";
import type { Bindings } from "../../types/bindings";

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

export async function getVideoEvidence(
  env: Bindings, scope: EvidenceScope, videoId: number,
) {
  if (!scope.videoIds.includes(videoId)) return null;
  return withDb(env, async db => {
    const [video] = await db.select({
      id: videos.id, title: videos.title, sourceType: videos.sourceType,
      fileKey: videos.file,
      transcript: sql<string | null>`CASE WHEN octet_length(${videos.transcript}) <= ${MAX_TRANSCRIPT_BYTES} THEN ${videos.transcript} ELSE NULL END`,
      transcriptTooLarge: sql<boolean>`COALESCE(octet_length(${videos.transcript}) > ${MAX_TRANSCRIPT_BYTES}, false)`,
    }).from(videos).where(and(
      eq(videos.id, videoId), eq(videos.userId, scope.ownerUserId),
      eq(videos.status, "completed"),
    )).limit(1);
    return video ?? null;
  });
}

export function createPostgresVideoEvidenceRepository(env: Bindings): VideoEvidenceRepository {
 return {getEvidence: (scope,videoId)=>getVideoEvidence(env,scope,videoId)};
}
