import {classroomVideoSummaries,classroomPlaybackVideo} from '../../../src/features/classroom/repository';
import {linkedLearningCourse} from '../../../src/repositories/linked-learning-repository';
import {createLtiRegistrationRepository} from '../../../src/persistence/factory';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {resolvedLtiConfig} from '../../../src/features/lti/registrations';
import {features} from '../../../src/lib/deployment';
import type {Bindings} from '../../../src/types/bindings';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;dispose:()=>Promise<void>};
export async function seedLtiRegistrations(execute:Fixture['execute']){
  for(const id of ['owner','other','installer'])await execute('INSERT INTO users(id) VALUES(?)',[id]);
  for(const id of [10,11,12])await execute(`INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at,managed_by_lms,native_access_disabled)
    VALUES(?,?,'course','',0,'2026-11-13','2026-11-13',?,?)`,[id,id===11?'other':'owner',id!==12,true]);
  for(const id of [1,2,3,4])await execute(`INSERT INTO videos(id,user_id,title,description,file,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id,managed_by_lms)
    VALUES(?,?,'video','','file.mp4','2026-11-13','',?,'',?,'',?,?)`,[id,id===3?'other':'owner',id===4?'processing':'completed',id===2?'youtube':'uploaded',id===2?'abcdefghijk':'',true]);
  await execute(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,materials_service,active)
    VALUES('school','installer','School','https://lms.example','client','deployment','https://lms.example/authorize','https://lms.example/jwks',?,?)`,[JSON.stringify({tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'}),true]);
  await execute(`INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id,active)
    VALUES('11111111-1111-4111-8111-111111111111','moodle','school','context','teacher','owner',10,?)`,[true]);
  for(const [id,kind,course,video,enabled] of [['video','video',10,1,true],['course','course',10,null,true],['youtube','youtube',10,2,true],['foreign-video','video',10,3,true],['foreign-course','video',11,1,true],['native-course','video',12,1,true],['disabled','video',10,1,false],['pending','video',10,4,true]] as const){
    await execute(`INSERT INTO lms_resources(id,installation_id,external_id,kind,context_id,resource_link_id,generation,manifest_hash,enabled,course_id,video_id,youtube_video_id)
      VALUES(?,'school',?,?,'context',?,1,?,?,?, ?,?)`,[id,id,kind,id,'a'.repeat(64),enabled,course,video,kind==='youtube'?'abcdefghijk':null]);
  }
}
export function ltiRegistrationContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} LTI registration contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    const registration=async()=> (await resolvedLtiConfig(f.env))?.registrations[0];
    const links=async()=> (await registration())?.resources.map(r=>r.resourceLinkId).sort();
    it('normalizes managed registrations and denies foreign, native and disabled resource bindings',async()=>{
      const snapshot=await (await createLtiRegistrationRepository(f.env)).snapshot();
      expect(snapshot.resources.find(r=>r.resourceLinkId==='video')).toMatchObject({courseId:10,videoId:1,courseOwner:'owner',videoOwner:'owner',installationId:'school'});
      const reg=await registration();expect(reg).toMatchObject({id:'db:school',issuer:'https://lms.example',clientId:'client',deploymentId:'deployment',
        frameOrigins:['https://lms.example'],materialsService:{endpoint:'https://lms.example/materials'}});
      const expected=['course','pending','video',...(features(f.env).youtube?['youtube']:[])].sort();expect(await links()).toEqual(expected);
      expect(reg?.resources.find(r=>r.resourceLinkId==='course')).toMatchObject({kind:'course',courseId:10,generation:1});
      expect(reg?.resources.find(r=>r.resourceLinkId==='pending')).toMatchObject({videoId:4,learningAvailable:false});
      expect(reg?.resources.find(r=>r.resourceLinkId==='video')).toMatchObject({videoId:1,learningAvailable:true});
    });
    it('rechecks installation revocation and account state on every request',async()=>{
      await f.execute('UPDATE lms_installations SET active=?',[false]);expect((await resolvedLtiConfig(f.env))?.registrations).toEqual([]);
      await f.execute('UPDATE lms_installations SET active=?',[true]);
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[false,'owner']);expect((await registration())?.resources).toEqual([]);
      await f.execute('UPDATE users SET is_active=?,deactivated_at=? WHERE id=?',[true,'2026-01-01','owner']);expect((await registration())?.resources).toEqual([]);
      await f.execute('UPDATE users SET deactivated_at=NULL,banned=?,ban_expires=? WHERE id=?',[true,'2099-01-01','owner']);expect((await registration())?.resources).toEqual([]);
      await f.execute('UPDATE users SET ban_expires=? WHERE id=?',['2000-01-01','owner']);expect((await registration())?.id).toBe('db:school');
    });
    it('keeps teacher access independent of the installer and filters platform-specific lookups',async()=>{
      const before=await links();
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[false,'installer']);
      expect(await links()).toEqual(before);
      expect((await resolvedLtiConfig(f.env,{issuer:'https://other.example',clientId:'client'}))?.registrations).toEqual([]);
      expect((await resolvedLtiConfig(f.env,{issuer:'https://lms.example',clientId:'client'}))?.registrations[0].id).toBe('db:school');
      await f.execute('UPDATE teaching_connections SET active=?',[false]);expect(await links()).toEqual([]);
    });
    it('includes only active owned native-course links for the matching provider and context',async()=>{
      await f.execute('UPDATE video_courses SET native_access_disabled=? WHERE id=?',[false,12]);
      await f.execute(`INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,resource_link_id,owner_user_id,course_id,active)
        VALUES('22222222-2222-4222-8222-222222222222','moodle','school','linked-context','teacher','linked-launch','owner',12,?)`,[true]);
      expect((await registration())?.resources.find(r=>r.resourceLinkId==='linked-launch')).toMatchObject({kind:'linked',courseId:12,contextId:'linked-context'});
      await f.execute('UPDATE teaching_connections SET owner_user_id=? WHERE context_id=?',['other','linked-context']);
      expect(await links()).not.toContain('linked-launch');
      await f.execute('UPDATE teaching_connections SET owner_user_id=?,active=? WHERE context_id=?',['owner',false,'linked-context']);
      expect(await links()).not.toContain('linked-launch');
    });
    it('rechecks current video ownership and course visibility',async()=>{
      await f.execute('UPDATE videos SET user_id=? WHERE id=?',['other',1]);expect(await links()).not.toContain('video');
      await f.execute('UPDATE video_courses SET native_access_disabled=? WHERE id=?',[false,10]);expect(await links()).toEqual([]);
    });
    it('resolves linked learning from the current teacher and returns only their completed course videos',async()=>{
      await f.execute('UPDATE video_courses SET native_access_disabled=? WHERE id=?',[false,12]);
      await f.execute(`INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,resource_link_id,owner_user_id,course_id,active)
        VALUES('22222222-2222-4222-8222-222222222222','moodle','school','linked-context','teacher','linked-launch','owner',12,?)`,[true]);
      for(const [video,order] of [[1,2],[2,1],[3,3],[4,4]])await f.execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(12,?,?,?)',[video,order,'2026-11-13T00:00:00Z']);
      expect(await linkedLearningCourse(f.env,'school','linked-context')).toEqual({courseId:12,ownerUserId:'owner',teacherSubject:'teacher',resourceLinkId:'linked-launch',courseTitle:'course',
        videos:[{videoId:2,lesson:'2',title:'video'},{videoId:1,lesson:'1',title:'video'}]});
      expect(await linkedLearningCourse(f.env,'other-installation','linked-context')).toBeNull();
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[false,'installer']);
      expect((await linkedLearningCourse(f.env,'school','linked-context'))?.videos).toHaveLength(2);
      await f.execute('UPDATE users SET banned=? WHERE id=?',[true,'owner']);
      expect(await linkedLearningCourse(f.env,'school','linked-context')).toBeNull();
      await f.execute('UPDATE users SET banned=? WHERE id=?',[false,'owner']);
      await f.execute('UPDATE teaching_connections SET owner_user_id=? WHERE context_id=?',['other','linked-context']);
      expect(await linkedLearningCourse(f.env,'school','linked-context')).toBeNull();
      await f.execute('UPDATE teaching_connections SET owner_user_id=?,active=? WHERE context_id=?',['owner',false,'linked-context']);
      expect(await linkedLearningCourse(f.env,'school','linked-context')).toBeNull();
    });
    it('hydrates only owned completed learning media metadata, including playlists exceeding one D1 bind group',async()=>{
      expect(await classroomVideoSummaries(f.env,'owner',[])).toEqual([]);
      expect(await classroomVideoSummaries(f.env,'owner',[2,1,1,3,4,999])).toEqual([{id:1,title:'video'},{id:2,title:'video'}]);
      expect(await classroomVideoSummaries(f.env,'owner',Array.from({length:260},(_,i)=>i+1))).toHaveLength(2);
      expect(await classroomPlaybackVideo(f.env,'owner',1)).toEqual({file:'file.mp4',sourceType:'uploaded',youtubeId:'',title:'video',description:''});
      expect(await classroomPlaybackVideo(f.env,'owner',2)).toMatchObject({sourceType:'youtube',youtubeId:'abcdefghijk'});
      expect(await classroomPlaybackVideo(f.env,'owner',3)).toBeNull();expect(await classroomPlaybackVideo(f.env,'owner',4)).toBeNull();
      await f.execute('UPDATE videos SET user_id=? WHERE id=?',['other',1]);
      expect(await classroomPlaybackVideo(f.env,'owner',1)).toBeNull();
      expect(await classroomVideoSummaries(f.env,'owner',[1,2])).toEqual([{id:2,title:'video'}]);
    });
    it('requires matching YouTube source identity and honors edition features',async()=>{
      expect((await links())?.includes('youtube')).toBe(features(f.env).youtube);
      await f.execute('UPDATE videos SET youtube_video_id=? WHERE id=?',['different12',2]);expect(await links()).not.toContain('youtube');
    });
    it('retains legacy authority without inventing a materials service',async()=>{
      await f.execute('UPDATE lms_installations SET materials_service=NULL,sync_token_hash=?',['c'.repeat(64)]);
      expect(await registration()).toMatchObject({courseAccess:'moodle'});expect((await registration())?.materialsService).toBeUndefined();
    });
    it('rejects duplicate static/database authorities and supports static-only configuration without a DB',async()=>{
      const staticReg={id:'static',issuer:'https://lms.example',clientId:'client',authorizationUrl:'https://lms.example/authorize',jwksUrl:'https://lms.example/jwks',frameOrigins:['https://lms.example'],resources:[{deploymentId:'deployment',contextId:'context',resourceLinkId:'video',courseId:10}]};
      await expect(resolvedLtiConfig({...f.env,LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[staticReg]})})).rejects.toThrow('Duplicate static/database LTI registration');
      const config=await resolvedLtiConfig({LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',registrations:[staticReg]})} as Bindings);
      expect(config?.registrations[0].id).toBe('static');
    });
  });
}
