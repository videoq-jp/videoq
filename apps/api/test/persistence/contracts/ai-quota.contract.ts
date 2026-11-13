import {afterEach,beforeEach,describe,expect,it} from "vitest";
import type {AiQuotaRepository,AiAnswerReservation} from "../../../src/persistence/contracts/ai-quota";
import type {ProcessingQuotaRepository} from "../../../src/persistence/contracts/processing-quota";
export interface AiQuotaFixture {
  ai:AiQuotaRepository;processing:ProcessingQuotaRepository;
  execute(sql:string,args?:unknown[]):Promise<void>;
  usage():Promise<{answers:number;processing:number;uploads:number}>;
  dispose():Promise<void>;
}
export function aiQuotaContract(name:string,create:()=>Promise<AiQuotaFixture>) {
  describe(`${name}: AI answer quota`,()=>{
    let f:AiQuotaFixture;
    beforeEach(async()=>{f=await create();});afterEach(async()=>{await f?.dispose();});
    it('admits at most the configured capacity under concurrent requests',async()=>{
      const results=await Promise.all(Array.from({length:20},()=>f.ai.reserve('owner')));
      expect(results.filter(r=>'reservation' in r)).toHaveLength(3);
      expect(results.filter(r=>'exceeded' in r)).toHaveLength(17);
      expect((await f.usage()).answers).toBe(3);
    });
    it('refunds concurrent reservations in their original usage period',async()=>{
      const results=await Promise.all(Array.from({length:3},()=>f.ai.reserve('owner')));
      const reservations=results.flatMap(r=>'reservation' in r?[r.reservation]:[]);
      expect(reservations).toHaveLength(3);
      expect(reservations[0]).toMatchObject({planCode:'basic',quotaSource:'admin'});
      await Promise.all(reservations.map(r=>f.ai.release(r)));
      expect((await f.usage()).answers).toBe(0);
      await f.ai.release(reservations[0]);
      expect((await f.usage()).answers).toBe(0);
    });
    it('does not refund an old period into new-month usage',async()=>{
      const result=await f.ai.reserve('owner');
      if (!('reservation' in result)) throw new Error('Expected reservation');
      await f.execute("UPDATE users SET usage_period_start='2000-01-01T00:00:00Z',used_ai_answers=99,used_processing_seconds=99");
      const current=await f.ai.reserve('owner');
      expect(current).toHaveProperty('reservation');
      await f.ai.release({...result.reservation,usagePeriodStart:'2000-01-01T00:00:00Z'});
      expect(await f.usage()).toEqual({answers:1,processing:0,uploads:55});
    });
    it('resets monthly AI/processing usage once across both operation types',async()=>{
      await f.execute("UPDATE users SET usage_period_start='2000-01-01T00:00:00Z',used_ai_answers=99,used_processing_seconds=999");
      const [answer,processing]=await Promise.all([f.ai.reserve('owner'),f.processing.reserve(1,60)]);
      expect(answer).toHaveProperty('reservation');expect(processing.allowed).toBe(true);
      expect(await f.usage()).toEqual({answers:1,processing:60,uploads:55});
    });
    it('denies blocked users before limit errors and supports unlimited plans',async()=>{
      await f.execute('UPDATE users SET is_over_quota=true,ai_answers_limit=0');
      expect(await f.ai.reserve('owner')).toEqual({overQuota:true});
      await f.execute('UPDATE users SET is_over_quota=false,ai_answers_limit=NULL');
      const results=await Promise.all(Array.from({length:8},()=>f.ai.reserve('owner')));
      expect(results.every(r=>'reservation' in r)).toBe(true);
      expect((await f.usage()).answers).toBe(8);
    });
    it('rejects a missing owner and ignores refunds for missing owners',async()=>{
      await expect(f.ai.reserve('missing')).rejects.toThrow('owner not found');
      await f.ai.release({userId:'missing',usagePeriodStart:new Date().toISOString(),planCode:'free',quotaSource:'plan'} satisfies AiAnswerReservation);
      expect((await f.usage()).answers).toBe(0);
    });
  });
}
