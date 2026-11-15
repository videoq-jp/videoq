import {afterEach,beforeEach,describe,expect,it} from "vitest";
import type {ReindexRepository} from "../../../src/persistence/contracts/reindex-repository";
export interface ReindexFixture {repository:ReindexRepository;remove(id:number):Promise<void>;dispose():Promise<void>}
const eligible=Array.from({length:35},(_,i)=>i+1).filter(id=>![2,4,6,8,10].includes(id));
export function reindexContract(name:string,create:()=>Promise<ReindexFixture>) {
  describe(`${name}: bounded reindex candidates`,()=>{
    let f:ReindexFixture;
    beforeEach(async()=>{f=await create();});
    afterEach(async()=>{await f?.dispose();});
    it('uses a bounded keyset page and excludes unfinished or empty videos',async()=>{
      const ids=await f.repository.candidateIds(0);
      expect(ids).toEqual(eligible.slice(0,26));
      expect(await f.repository.candidateIds(ids[24])).toEqual(eligible.slice(25));
    });
    it('keeps cursor semantics when earlier videos disappear',async()=>{
      const first=await f.repository.candidateIds(0);
      await f.remove(1);
      expect(await f.repository.candidateIds(first[24])).toEqual(eligible.slice(25));
      expect((await f.repository.candidateIds(0))[0]).toBe(3);
    });
    it('rejects invalid cursors and accepts an exhausted safe cursor',async()=>{
      for (const cursor of [-1,NaN,1.2,Number.MAX_SAFE_INTEGER+1]) await expect(f.repository.candidateIds(cursor)).rejects.toThrow('cursor');
      expect(await f.repository.candidateIds(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
  });
}
