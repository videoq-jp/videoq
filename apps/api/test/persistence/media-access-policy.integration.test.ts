import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, videos, videoCourses, videoCourseMembers, videoCourseMemberships, videoCourseInvitations } from '../../src/db/schema';
import { getMediaPathAccess } from '../../src/repositories/media-repository';
import type { Bindings } from '../../src/types/bindings';
import { createD1Fixture } from './d1-fixture';
import { isolatedPostgres } from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres'] as const)describe.skipIf(backend==='postgres'&&!url)(`${backend} media path policy`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,dispose:()=>Promise<void>;
  beforeEach(async()=>{
    if(backend==='d1'){
      const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
      execute=async(query,args=[])=>{await f.database.prepare(query).bind(...args.map(value=>typeof value==='boolean'?Number(value):value)).run();};
    }else{
      const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
      try{await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,videoCourseMemberships,videoCourseInvitations}))).map(s=>s.replaceAll('"public".','')).join('\n'));}
      catch(error){await dispose();throw error;}
      execute=async(query,args=[])=>{let i=0;await f.pool.query(query.replaceAll('?',()=>`$${++i}`),args);};
    }
    for(const id of ['owner','learner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',[id,id,id+'@example.test',false]);
    for(const [id,file,status]of [[1,'lesson.mp4','completed'],[2,'processing.mp4','processing']] as const){
      await execute("INSERT INTO videos(id,user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(?,'owner',?,'Video','','2026-11-20','',?,'','uploaded','','')",[id,file,status]);
    }
    await execute("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at,share_slug) VALUES(1,'owner','Course','',0,'2026-11-20','2026-11-20','public')");
    for(const id of [1,2])await execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(1,?,?,?)',[id,id,'2026-11-20']);
    await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'learner','2026-11-20')");
  });
  afterEach(async()=>{await dispose?.();});
  it('preserves invalid-share precedence and distinguishes unauthorized paths',async()=>{
    expect(await getMediaPathAccess(env,'../lesson.mp4',{userId:'owner',shareSlug:'missing'})).toBeNull();
    expect(await getMediaPathAccess(env,'../lesson.mp4',{userId:'owner',shareSlug:'public'})).toBe(false);
    expect(await getMediaPathAccess(env,'lesson.mp4',{userId:'owner',shareSlug:''})).toBeNull();
    expect(await getMediaPathAccess(env,'missing.mp4',{shareSlug:'public'})).toBe(false);
    expect(await getMediaPathAccess(env,'lesson.mp4',{userId:'other'})).toBe(false);
    expect(await getMediaPathAccess(env,"' OR 1=1 --",{shareSlug:'public'})).toBe(false);
  });
  it('does not add a completed-video condition and rechecks native membership',async()=>{
    expect(await getMediaPathAccess(env,'processing.mp4',{userId:'owner'})).toBe(true);
    expect(await getMediaPathAccess(env,'processing.mp4',{userId:'learner'})).toBe(true);
    expect(await getMediaPathAccess(env,'processing.mp4',{shareSlug:'public'})).toBe(true);
    await execute("DELETE FROM video_course_memberships WHERE user_id='learner'");
    expect(await getMediaPathAccess(env,'processing.mp4',{userId:'learner'})).toBe(false);
    expect(await getMediaPathAccess(env,'processing.mp4',{userId:'owner'})).toBe(true);
  });
  it.each(['managed','disabled','mixed'] as const)('keeps owner access independent of %s native share/member admission',async kind=>{
    if(kind==='mixed')await execute('UPDATE videos SET managed_by_lms=? WHERE id=1',[true]);
    else await execute(`UPDATE video_courses SET ${kind==='managed'?'managed_by_lms':'native_access_disabled'}=? WHERE id=1`,[true]);
    expect(await getMediaPathAccess(env,'lesson.mp4',{userId:'owner'})).toBe(true);
    expect(await getMediaPathAccess(env,'lesson.mp4',{userId:'owner',shareSlug:'public'})).toBeNull();
    expect(await getMediaPathAccess(env,'lesson.mp4',{userId:'learner'})).toBe(false);
    expect(await getMediaPathAccess(env,'lesson.mp4',{shareSlug:'public'})).toBeNull();
  });
});
