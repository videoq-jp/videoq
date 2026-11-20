import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, videos, videoCourses, videoCourseMembers, teachingConnections } from '../../src/db/schema';
import { createLearningMediaRepository, createLinkedLearningRepository } from '../../src/persistence/factory';
import type { Bindings } from '../../src/types/bindings';
import { createD1Fixture } from './d1-fixture';
import { isolatedPostgres } from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres'] as const)describe.skipIf(backend==='postgres'&&!url)(`${backend} current learning media admission`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,dispose:()=>Promise<void>;
  beforeEach(async()=>{
    if(backend==='d1'){
      const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
      execute=async(query,args=[])=>{await f.database.prepare(query).bind(...args.map(value=>typeof value==='boolean'?Number(value):value)).run();};
    }else{
      const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
      try{await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,teachingConnections}))).map(s=>s.replaceAll('"public".','')).join('\n'));}
      catch(error){await dispose();throw error;}
      execute=async(query,args=[])=>{let i=0;await f.pool.query(query.replaceAll('?',()=>`$${++i}`),args);};
    }
    for(const id of ['owner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',[id,id,id+'@example.test',false]);
    await execute("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at) VALUES(1,'owner','Course','',0,'2026-11-20','2026-11-20')");
    await execute("INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id,resource_link_id) VALUES('11111111-1111-4111-8111-111111111111','moodle','school','class','teacher','owner',1,'entry')");
    for(const [id,owner,status,title]of [[1,'owner','completed',''],[2,'owner','processing','Pending'],[3,'other','completed','Foreign'],[4,'owner','completed',' Lesson ']] as const){
      await execute("INSERT INTO videos(id,user_id,title,description,file,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(?,?,?,'',?,'2026-11-20','caption',?,'','uploaded','','')",[id,owner,title,`${id}.mp4`,status]);
    }
    for(const [id,order]of [[4,0],[2,1],[1,2],[3,3]])await execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(1,?,?,?)',[id,order,'2026-11-20']);
  });
  afterEach(async()=>{await dispose?.();});
  const linked=async()=> (await createLinkedLearningRepository(env)).findCourse('school','class');
  it('returns current owned completed members in course order and retains empty-course context',async()=>{
    expect(await linked()).toMatchObject({courseId:1,ownerUserId:'owner',teacherSubject:'teacher',resourceLinkId:'entry',videos:[{videoId:4,lesson:'4',title:' Lesson '},{videoId:1,lesson:'1',title:'Course'}]});
    await execute("UPDATE videos SET status='processing' WHERE user_id='owner'");
    expect(await linked()).toMatchObject({courseId:1,videos:[]});
  });
  it('rechecks course, connection and current account authority',async()=>{
    for(const [change,restore]of [
      ['UPDATE teaching_connections SET active=false','UPDATE teaching_connections SET active=true'],
      ['UPDATE video_courses SET native_access_disabled=true','UPDATE video_courses SET native_access_disabled=false'],
      ["UPDATE video_courses SET user_id='other'","UPDATE video_courses SET user_id='owner'"],
      ["UPDATE users SET is_active=false WHERE id='owner'","UPDATE users SET is_active=true WHERE id='owner'"],
      ["UPDATE users SET deactivated_at='2000-01-01' WHERE id='owner'","UPDATE users SET deactivated_at=NULL WHERE id='owner'"],
      ["UPDATE users SET banned=true,ban_expires='2099-01-01' WHERE id='owner'","UPDATE users SET banned=false,ban_expires=NULL WHERE id='owner'"],
    ]){await execute(change);expect(await linked()).toBeNull();await execute(restore);expect(await linked()).not.toBeNull();}
    await execute("UPDATE users SET banned=NULL WHERE id='owner'");expect(await linked()).not.toBeNull();
    await execute("UPDATE users SET banned=true,ban_expires='2000-01-01' WHERE id='owner'");expect(await linked()).not.toBeNull();
  });
  it('filters owner/status on playback and deduplicates/sorts large summary requests',async()=>{
    const media=await createLearningMediaRepository(env);
    expect(await media.playback('owner',1)).toMatchObject({file:'1.mp4',title:''});
    for(const id of [2,3,999])expect(await media.playback('owner',id)).toBeNull();
    expect(await media.playback('other',1)).toBeNull();
    expect(await media.summaries('owner',[])).toEqual([]);
    expect(await media.summaries('owner',[4,4,1,...Array.from({length:2100},(_,i)=>2100-i)])).toEqual([{id:1,title:''},{id:4,title:' Lesson '}]);
  });
});
