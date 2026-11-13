import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {CourseRepository} from '../../../src/persistence/contracts/course-repository';
type Fixture={repository:CourseRepository;execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;failCreate:()=>Promise<void>;failDelete:()=>Promise<void>;dispose:()=>Promise<void>};
export async function seedCourses(execute:Fixture['execute']){
  for(const id of ['owner','learner','other'])await execute('INSERT INTO users(id) VALUES(?)',[id]);
  for(const id of [1,2,3])await execute(`INSERT INTO videos(id,user_id,title,description,file,uploaded_at,status,source_type,source_url,youtube_video_id,managed_by_lms,transcript,error_message)
    VALUES(?,'owner',?,'😀日本語 abc','file.mp4','2026-11-13T00:00:00Z','completed','uploaded','','',?,'','')`,[id,`video${id}`,id===3]);
  for(const id of [10,20,30,40])await execute(`INSERT INTO video_courses(id,user_id,name,description,display_order,share_slug,created_at,updated_at,managed_by_lms,native_access_disabled)
    VALUES(?,?,?,'😀日本語 abc',?,?, '2026-11-13T00:00:00Z','2026-11-13T00:00:00Z',?,?)`,[id,id===20?'other':'owner',`course${id}`,id===10?2:id===40?7:0,id===10?'shared':null,id===30,false]);
  for(const [course,video,order] of [[10,1,0],[10,2,1],[30,3,0],[40,3,0]])await execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(?,?,?,?)',[course,video,order,'2026-11-13']);
  for(const course of [10,30,40])await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(?,'learner','2026-11-13')",[course]);
  await execute("INSERT INTO tags(id,user_id,name,color,created_at) VALUES(1,'owner','tag','#123456','2026-11-13')");
  await execute("INSERT INTO video_tags(video_id,tag_id,added_at) VALUES(1,1,'2026-11-13')");
}
export function courseContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} course contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    it('normalizes detail and supports member pages, optional tags and file suppression',async()=>{
      const detail=await f.repository.getDetail(10,'owner',{includeFileUrls:false});
      expect(detail).toMatchObject({id:10,access_role:'owner',video_count:2,share_slug:'shared'});expect(detail?.created_at).toMatch(/Z$/);
      expect(detail?.videos.map(v=>v.id)).toEqual([1,2]);expect(detail?.videos[0]).toMatchObject({file:null,tags:[{id:1,name:'tag',color:'#123456'}]});
      const page=await f.repository.getDetail(10,'learner',{includeTags:false,includeFileUrls:false,videoLimit:1,videoOffset:1});
      expect(page).toMatchObject({access_role:'member',video_count:2,videos:[{id:2,tags:[]}]});
      expect((await f.repository.getDetail(10,'owner',{videoOffset:1,includeFileUrls:false}))?.videos.map(v=>v.id)).toEqual([2]);
      expect((await f.repository.getDetail(10,'owner',{videoOffset:9}))?.videos).toEqual([]);
      expect(await f.repository.getDetail(10,'other')).toBeNull();
    });
    it('keeps LMS material private to the owner and applies native membership authority consistently',async()=>{
      expect((await f.repository.getDetail(30,'owner',{includeFileUrls:false}))?.access_role).toBe('owner');
      expect(await f.repository.getDetail(30,'learner')).toBeNull();expect(await f.repository.getDetail(40,'learner')).toBeNull();
      expect((await f.repository.listPage('learner',10,0)).results.map(c=>c.id)).toEqual([10]);
      expect(await f.repository.setShareSlug(30,'owner','lms')).toEqual({notFound:true});expect(await f.repository.setShareSlug(40,'owner','protected')).toEqual({notFound:true});
      await f.execute("UPDATE video_courses SET native_access_disabled=? WHERE id=10",[true]);
      expect(await f.repository.getDetail(10,'learner')).toBeNull();expect(await f.repository.getShared('shared')).toBeNull();
    });
    it('lists owned courses before memberships and normalizes counts and paging',async()=>{
      const list=await f.repository.listPage('owner',20,0);expect(list.count).toBe(3);expect(list.results.every(c=>c.access_role==='owner')).toBe(true);
      expect(list.results.find(c=>c.id===10)?.video_count).toBe(2);
      expect(await f.repository.listPage('owner',2,20)).toEqual({count:3,results:[]});
      const page=await f.repository.listPage('learner',1,0);expect(page).toMatchObject({count:1,results:[{id:10,access_role:'member'}]});
    });
    it('reads bounded Unicode metadata only for the verified owner',async()=>{
      const options={videoLimit:1,videoOffset:0,courseDescriptionLimit:2,videoDescriptionLimit:2};
      const info=await f.repository.getInfo(10,'owner',options);
      expect(info).toMatchObject({description:'😀日本',video_count:2,videos:[{id:1,description:'😀日本',status:'completed',order:0}]});
      expect((await f.repository.getInfo(10,'owner',{...options,videoOffset:2}))?.videos).toEqual([]);
      expect(await f.repository.getInfo(10,'learner',options)).toBeNull();
    });
    it('creates concurrently with stable idempotency and per-user order allocation',async()=>{
      const key={action:'create_course' as const,key:'same',requestHash:'a'.repeat(64)};
      const results=await Promise.all([f.repository.create('owner','created','description',key),f.repository.create('owner','created','description',key)]);
      expect(results.every(r=>'ok' in r)).toBe(true);const ids=results.map(r=>'ok' in r?r.courseId:0);expect(new Set(ids).size).toBe(1);
      expect(results.filter(r=>'ok' in r && r.reused)).toHaveLength(1);
      expect(await f.repository.create('owner','changed','description',{...key,requestHash:'b'.repeat(64)})).toEqual({idempotencyConflict:true});
      const next=await f.repository.create('owner','next','');if(!('ok' in next))throw new Error('missing creation');
      expect((await f.repository.getDetail(next.courseId,'owner'))?.display_order).toBe(9);
      expect(await f.count('mcp_idempotency_records')).toBe(1);
    });
    it('allocates distinct append slots for concurrent independent creations',async()=>{
      const created=await Promise.all(['first','second'].map(name=>f.repository.create('owner',name,'')));
      const details=await Promise.all(created.map(r=>{if(!('ok' in r))throw new Error('missing course');return f.repository.getDetail(r.courseId,'owner');}));
      expect(details.map(r=>r?.display_order).sort()).toEqual([8,9]);expect(await f.count('mcp_idempotency_records')).toBe(0);
    });
    it('rolls back course creation if its idempotency record cannot be stored',async()=>{
      const before=await f.count('video_courses');await f.failCreate();
      await expect(f.repository.create('owner','failed','',{action:'create_course',key:'failure',requestHash:'a'.repeat(64)})).rejects.toThrow();
      expect(await f.count('video_courses')).toBe(before);
    });
    it('updates only editable owned courses and retains updated_at and member shape',async()=>{
      const before=await f.repository.getDetail(10,'owner',{includeFileUrls:false});
      const updated=await f.repository.update(10,'owner',{name:'renamed',description:''});
      expect(updated).toMatchObject({course:{name:'renamed',description:'',updated_at:before?.updated_at,video_count:2,videos:[{id:1,tags:[]},{id:2,tags:[]}]}});
      expect(await f.repository.update(20,'owner',{name:'forbidden'})).toEqual({notFound:true});
      expect(await f.repository.update(30,'owner',{})).toEqual({notFound:true});
    });
    it('preserves selected order slots and refuses missing, duplicate or foreign IDs',async()=>{
      expect(await f.repository.reorder('owner',[40,10])).toEqual({ok:true});
      expect((await f.repository.getDetail(40,'owner',{includeFileUrls:false}))?.display_order).toBe(2);
      expect((await f.repository.getDetail(10,'owner',{includeFileUrls:false}))?.display_order).toBe(7);
      for(const ids of [[],[10,10],[10,20],[999]])expect(await f.repository.reorder('owner',ids)).toEqual({mismatch:true});
      expect((await f.repository.getDetail(10,'owner',{includeFileUrls:false}))?.display_order).toBe(7);
      expect(await f.repository.reorder('owner',[40,10])).toEqual({ok:true});
    });
    it('enforces case-insensitive slug uniqueness and exact public lookup with atomic clearing',async()=>{
      expect(await f.repository.setShareSlug(20,'other','SHARED')).toEqual({conflict:true});
      expect((await f.repository.getShared('shared',{includeFileUrls:false}))?.access_role).toBe('public');expect(await f.repository.getShared('SHARED')).toBeNull();
      expect(await f.repository.setShareSlug(10,'other','stolen')).toEqual({notFound:true});
      expect(await f.repository.clearShareSlug(10,'owner')).toEqual({ok:true});expect(await f.repository.clearShareSlug(10,'owner')).toEqual({notConfigured:true});
      expect(await f.repository.clearShareSlug(10,'other')).toEqual({notFound:true});expect(await f.repository.getShared('shared')).toBeNull();
    });
    it('cascades course logs, conversations and member links while keeping underlying videos',async()=>{
      await f.execute(`INSERT INTO chat_logs(id,course_id,user_id,question,response,retrieved_contexts,is_shared_origin,created_at)
        VALUES(1,10,'owner','question',?,'[]',?,'2026-11-13')`,[JSON.stringify({segments:[],sources:[]}),false]);
      await f.execute(`INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,actor_user_id,course_id,expires_at)
        VALUES('course-thread',?,'owner','owner',10,'2099-01-01')`,[crypto.randomUUID()]);
      await f.execute(`INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response,chat_log_id)
        VALUES('course-thread','checkpoint','question',?,1)`,[JSON.stringify({segments:[],sources:[]})]);
      expect(await f.repository.delete(10,'owner')).toEqual({ok:true});
      for(const table of ['chat_logs','chat_conversations','chat_conversation_turns'])expect(await f.count(table)).toBe(0);
      expect(await f.count('video_course_members')).toBe(2);expect(await f.count('video_course_memberships')).toBe(2);expect(await f.count('videos')).toBe(3);
    });
    it('deletes owned native courses and creation records atomically without deleting videos',async()=>{
      const created=await f.repository.create('owner','delete','',{action:'create_course',key:'delete',requestHash:'a'.repeat(64)});if(!('ok' in created))throw new Error('missing creation');
      expect(await f.repository.delete(10,'owner')).toEqual({ok:true});expect(await f.count('videos')).toBe(3);
      expect(await f.count('video_course_members')).toBe(2);expect(await f.count('video_course_memberships')).toBe(2);
      expect(await f.repository.delete(created.courseId,'owner')).toEqual({ok:true});expect(await f.count('mcp_idempotency_records')).toBe(0);
      const retry=await f.repository.create('owner','failed delete','',{action:'create_course',key:'delete',requestHash:'a'.repeat(64)});if(!('ok' in retry))throw new Error('missing retry');
      expect(retry.reused).toBe(false);await f.failDelete();await expect(f.repository.delete(retry.courseId,'owner')).rejects.toThrow();expect(await f.count('mcp_idempotency_records')).toBe(1);
      expect(await f.repository.delete(10,'other')).toEqual({notFound:true});expect(await f.repository.delete(30,'owner')).toEqual({notFound:true});
    });
  });
}
