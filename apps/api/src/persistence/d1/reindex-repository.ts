import { reindexCandidateAllowed } from '../../application/media-eligibility';
import { mediaStringLogic } from '../media-eligibility-sql';
import { REINDEX_PAGE_SIZE,validateReindexCursor,type ReindexRepository } from "../contracts/reindex-repository";
export function createD1ReindexRepository(database:D1Database):ReindexRepository {
  return {async candidateIds(afterId) {
    validateReindexCursor(afterId);
    const eligible=reindexCandidateAllowed('status','transcript',mediaStringLogic);
    const rows=await database.prepare(`SELECT id FROM videos WHERE id>? AND ${eligible} ORDER BY id LIMIT ?`).bind(afterId,REINDEX_PAGE_SIZE+1).all<{id:number}>();
    return rows.results.map(row=>row.id);
  }};
}
