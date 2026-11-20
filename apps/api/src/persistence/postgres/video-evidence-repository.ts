import { evidenceVideoSelected, inlineTranscript } from '../../application/content-read';
import { learningVideoAllowed } from '../../application/media-eligibility';
import { mediaDrizzleLogic } from '../media-eligibility-sql';
import { contentDrizzleLogic } from '../content-read-policy-sql';
import type { EvidenceScope, VideoEvidenceRepository } from "../contracts/video-evidence-repository";
import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { videos } from "../../db/schema";
import type { Bindings } from "../../types/bindings";



export async function getVideoEvidence(
  env: Bindings, scope: EvidenceScope, videoId: number,
) {
  if (!evidenceVideoSelected(scope.videoIds,videoId)) return null;
  return withDb(env, async db => {
    const transcript=inlineTranscript(sql`${videos.transcript}`,sql`octet_length(${videos.transcript})`,contentDrizzleLogic);
    const [video] = await db.select({
      id: videos.id, title: videos.title, sourceType: videos.sourceType,
      fileKey: videos.file,
      transcript: sql<string | null>`${transcript.value}`,
      transcriptTooLarge: sql<boolean>`${transcript.tooLarge}`,
    }).from(videos).where(and(
      eq(videos.id, videoId), learningVideoAllowed(eq(videos.userId, scope.ownerUserId),videos.status,mediaDrizzleLogic),
    )).limit(1);
    return video ?? null;
  });
}

export function createPostgresVideoEvidenceRepository(env: Bindings): VideoEvidenceRepository {
 return {getEvidence: (scope,videoId)=>getVideoEvidence(env,scope,videoId)};
}
