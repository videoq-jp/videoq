import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, videos } from '../../src/db/schema';
import { getVideoEvidence } from '../../src/repositories/video-evidence-repository';
import { MAX_INLINE_TRANSCRIPT_BYTES } from '../../src/domain/media/content-read';
import type { Bindings } from '../../src/types/bindings';
import { createD1Fixture } from './d1-fixture';
import { isolatedPostgres } from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres'] as const)describe.skipIf(backend==='postgres'&&!url)(`${backend} bounded evidence content`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,dispose:()=>Promise<void>;
  beforeEach(async()=>{
    if(backend==='d1'){
      const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
      execute=async(query,args=[])=>{await f.database.prepare(query).bind(...args.map(value=>typeof value==='boolean'?Number(value):value)).run();};
    }else{
      const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
      try{await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos}))).map(s=>s.replaceAll('"public".','')).join('\n'));}
      catch(error){await dispose();throw error;}
      execute=async(query,args=[])=>{let i=0;await f.pool.query(query.replaceAll('?',()=>`$${++i}`),args);};
    }
    await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',false,0,0,0)");
    await execute("INSERT INTO videos(id,user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','lesson.mp4','Lesson','','2026-11-20','caption','completed','','uploaded','','')");
  });
  afterEach(async()=>{await dispose?.();});
  const read=()=>getVideoEvidence(env,{ownerUserId:'owner',videoIds:[1]},1);
  it('measures UTF-8 bytes at the exact cap and omits the first oversized value',async()=>{
    const count=MAX_INLINE_TRANSCRIPT_BYTES/4;
    const content=backend==='d1'?"replace(hex(zeroblob(?)),'00','😀')":"repeat('😀',?)";
    await execute(`UPDATE videos SET transcript=${content} WHERE id=1`,[count]);
    const exact=await read();expect(exact?.transcriptTooLarge).toBe(false);
    expect(new TextEncoder().encode(exact!.transcript!).byteLength).toBe(MAX_INLINE_TRANSCRIPT_BYTES);
    await execute("UPDATE videos SET transcript=transcript||'x' WHERE id=1");
    expect(await read()).toMatchObject({transcript:null,transcriptTooLarge:true});
  });
  it('keeps owner, selected-video and completed-state admission',async()=>{
    expect(await read()).toMatchObject({id:1,transcript:'caption',transcriptTooLarge:false});
    expect(await getVideoEvidence(env,{ownerUserId:'other',videoIds:[1]},1)).toBeNull();
    expect(await getVideoEvidence(env,{ownerUserId:'owner',videoIds:[]},1)).toBeNull();
    await execute("UPDATE videos SET status='processing' WHERE id=1");expect(await read()).toBeNull();
  });
});
