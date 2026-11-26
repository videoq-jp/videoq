import { and, gt, sql } from "drizzle-orm";
import { videos } from "../../db/schema";
import { reindexCandidateAllowed } from "../../domain/media/media-eligibility";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import { withDb } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import {
  REINDEX_PAGE_SIZE,
  validateReindexCursor,
  type ReindexRepository,
} from "../contracts/reindex-repository";
export function createPostgresReindexRepository(
  env: Bindings,
): ReindexRepository {
  return {
    async candidateIds(afterId) {
      validateReindexCursor(afterId);
      return withDb(env, async (db) => {
        const rows = await db
          .select({ id: videos.id })
          .from(videos)
          .where(
            and(
              gt(videos.id, sql`${afterId}::bigint`),
              reindexCandidateAllowed(
                videos.status,
                videos.transcript,
                mediaDrizzleLogic,
              ),
            ),
          )
          .orderBy(videos.id)
          .limit(REINDEX_PAGE_SIZE + 1);
        return rows.map((row) => Number(row.id));
      });
    },
  };
}
