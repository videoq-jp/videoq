export const REINDEX_PAGE_SIZE=25;
export interface ReindexRepository { candidateIds(afterId:number):Promise<number[]>; }
export function validateReindexCursor(afterId:number) {
  if (!Number.isSafeInteger(afterId) || afterId<0) throw new Error("Invalid reindex cursor");
}
