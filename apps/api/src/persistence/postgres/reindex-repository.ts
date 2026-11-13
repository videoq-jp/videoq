import { withClient } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import { REINDEX_PAGE_SIZE,validateReindexCursor,type ReindexRepository } from "../contracts/reindex-repository";
export function createPostgresReindexRepository(env:Bindings):ReindexRepository {
  return {async candidateIds(afterId) {
    validateReindexCursor(afterId);
    return withClient(env,async client=>(await client.query<{id:number}>(`SELECT id FROM videos WHERE id>$1::bigint
      AND status='completed' AND transcript IS NOT NULL AND transcript<>'' ORDER BY id LIMIT $2`,[afterId,REINDEX_PAGE_SIZE+1])).rows.map(row=>Number(row.id)));
  }};
}
