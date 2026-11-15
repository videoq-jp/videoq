import { REINDEX_PAGE_SIZE,validateReindexCursor,type ReindexRepository } from "../contracts/reindex-repository";
export function createD1ReindexRepository(database:D1Database):ReindexRepository {
  return {async candidateIds(afterId) {
    validateReindexCursor(afterId);
    const rows=await database.prepare(`SELECT id FROM videos WHERE id>? AND status='completed'
      AND transcript IS NOT NULL AND transcript<>'' ORDER BY id LIMIT ?`).bind(afterId,REINDEX_PAGE_SIZE+1).all<{id:number}>();
    return rows.results.map(row=>row.id);
  }};
}
