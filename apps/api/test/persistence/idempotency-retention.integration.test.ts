import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, mcpIdempotencyRecords } from '../../src/db/schema';
import { pruneMcpIdempotencyRecords } from '../../src/repositories/mcp-idempotency-repository';
import { createD1Fixture } from './d1-fixture';
import { isolatedPostgres } from './isolated-postgres';
import type { Bindings } from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres'] as const){
  describe.skipIf(backend==='postgres'&&!url)(`${backend} MCP idempotency retention`,()=>{
    let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,remaining:()=>Promise<string[]>,dispose:()=>Promise<void>;
    beforeEach(async()=>{
      if(backend==='d1'){
        const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
        execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
        remaining=async()=>(await f.database.prepare('SELECT key FROM mcp_idempotency_records ORDER BY key').all<{key:string}>()).results.map(r=>r.key);
      }else{
        const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
        await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,mcpIdempotencyRecords}))).map(s=>s.replaceAll('"public".','')).join('\n'));
        execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
        remaining=async()=>(await f.pool.query<{key:string}>('SELECT key FROM mcp_idempotency_records ORDER BY key')).rows.map(r=>r.key);
      }
      for(const id of ['owner','peer'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',[id,id,id+'@example.test',false]);
    });
    afterEach(async()=>{await dispose?.();});
    const seed=async(key:string,days:number,owner='owner')=>execute('INSERT INTO mcp_idempotency_records(user_id,action,key,request_hash,resource_id,created_at) VALUES(?,?,?,?,?,?)',[owner,'create_course',key,'a'.repeat(64),1,new Date(Date.now()-days*86400000).toISOString()]);
    it('bounds each sweep, retains recent and future requests, and counts only deleted rows',async()=>{
      await seed('old-a',90);await seed('old-b',80,'peer');await seed('old-c',70);await seed('recent',1);await seed('future',-2);
      expect(await pruneMcpIdempotencyRecords(env,30,2)).toEqual({deleted:2});expect(await remaining()).toEqual(['future','old-c','recent']);
      expect(await pruneMcpIdempotencyRecords(env,30,2)).toEqual({deleted:1});expect(await remaining()).toEqual(['future','recent']);
      expect(await pruneMcpIdempotencyRecords(env,30,2)).toEqual({deleted:0});
    });
    it('uses the configured retention window and preserves composite identities',async()=>{
      await seed('same',60);await seed('same',1,'peer');await seed('middle',20);
      expect(await pruneMcpIdempotencyRecords(env,45,500)).toEqual({deleted:1});expect(await remaining()).toEqual(['middle','same']);
      expect(await pruneMcpIdempotencyRecords(env,10,500)).toEqual({deleted:1});expect(await remaining()).toEqual(['same']);
    });
    it('validates cleanup bounds before changing data',async()=>{
      await seed('old',90);
      for(const [days,limit]of [[0,1],[1.5,1],[30,0],[30,5001],[30,1.5]])await expect(pruneMcpIdempotencyRecords(env,days,limit)).rejects.toThrow();
      expect(await remaining()).toEqual(['old']);
    });
  });
}
