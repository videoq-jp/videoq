import { reindexCandidateAllowed } from '../../application/media-eligibility';
import { mediaStringLogic } from '../media-eligibility-sql';
import { withClient } from "../../db/pool";
import type { Bindings } from "../../types/bindings";
import { REINDEX_PAGE_SIZE,validateReindexCursor,type ReindexRepository } from "../contracts/reindex-repository";
export function createPostgresReindexRepository(env:Bindings):ReindexRepository {
  return {async candidateIds(afterId) {
    validateReindexCursor(afterId);
    const eligible=reindexCandidateAllowed('status','transcript',mediaStringLogic);
    return withClient(env,async client=>(await client.query<{id:number}>(`SELECT id FROM videos WHERE id>$1::bigint
      AND ${eligible} ORDER BY id LIMIT $2`,[afterId,REINDEX_PAGE_SIZE+1])).rows.map(row=>Number(row.id)));
  }};
}
