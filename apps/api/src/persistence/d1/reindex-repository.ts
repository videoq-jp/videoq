import { and, gt } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { videos } from "../../db/schema/sqlite";
import { reindexCandidateAllowed } from "../../application/media-eligibility";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import {
  REINDEX_PAGE_SIZE,
  validateReindexCursor,
  type ReindexRepository,
} from "../contracts/reindex-repository";
export function createD1ReindexRepository(
  database: D1Database,
): ReindexRepository {
  const db = createD1Connection(database);
  return {
    async candidateIds(afterId) {
      validateReindexCursor(afterId);
      const rows = await db
        .select({ id: videos.id })
        .from(videos)
        .where(
          and(
            gt(videos.id, afterId),
            reindexCandidateAllowed(
              videos.status,
              videos.transcript,
              mediaDrizzleLogic,
            ),
          ),
        )
        .orderBy(videos.id)
        .limit(REINDEX_PAGE_SIZE + 1);
      return rows.map((row) => row.id);
    },
  };
}
