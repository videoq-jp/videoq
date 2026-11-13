import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {getLmsResource} from '../../../src/repositories/lms-resource-repository';
import type {Bindings} from '../../../src/types/bindings';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;dispose:()=>Promise<void>};
export async function seedLmsResourceRead(execute:Fixture['execute']){
 for(const id of ['owner','other','installer'])await execute('INSERT INTO users(id) VALUES(?)',[id]);
 await execute(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash,active)
  VALUES('school','installer','School','https://lms.example','client','2','https://lms.example/auth','https://lms.example/jwks',?,true)`,['a'.repeat(64)]);
 await execute(`INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at,managed_by_lms,native_access_disabled)
  VALUES(10,'owner','course','',0,'2026-11-13T00:00:00Z','2026-11-13T00:00:00Z',true,true)`);
 await execute("INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id,active) VALUES(?,'moodle','school','context','teacher','owner',10,true)",[crypto.randomUUID()]);
 await execute(`INSERT INTO videos(id,user_id,managed_by_lms,transcription_language,file,multipart_upload,upload_heartbeat_at,upload_usage_period_start,title,description,uploaded_at,transcript,status,error_message,processing_seconds,source_type,source_url,youtube_video_id)
  VALUES(1,'owner',true,'en','file.mp4',?,'2026-11-13T01:00:00Z','2026-11-01T00:00:00Z','Video','description','2026-11-13T00:00:00Z','transcript','uploading','',5,'uploaded','','')`,[JSON.stringify({uploadId:'upload',partSize:5,contentType:'video/mp4'})]);
 await execute(`INSERT INTO lms_resources(id,installation_id,external_id,kind,context_id,resource_link_id,generation,manifest_hash,enabled,content_hash,content_type,file_size,course_id,video_id,sync_error,updated_at)
  VALUES(?,'school','source','video','context','activity',3,?,true,?,'video/mp4',100,10,1,NULL,'2026-11-13T00:00:00Z')`,['11111111-1111-4111-8111-111111111111','b'.repeat(64),'c'.repeat(64)]);
}
export function lmsResourceReadContract(name:string,setup:()=>Promise<Fixture>){
 describe(`${name} LMS resource read contract`,()=>{
  let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const grant={id:'school',ownerUserId:'owner'};
  const read=()=>getLmsResource(f.env,grant,'source');
  it('normalizes complete resource and source metadata without losing joined identities',async()=>{
   const data=await read();expect(data).toMatchObject({ownerUserId:'owner',resource:{id:'11111111-1111-4111-8111-111111111111',installationId:'school',externalId:'source',kind:'video',enabled:true,generation:3,fileSize:100,courseId:10,videoId:1,updatedAt:'2026-11-13T00:00:00.000Z'},
    video:{id:1,userId:'owner',managedByLms:true,status:'uploading',transcriptionLanguage:'en',processingSeconds:5,file:'file.mp4',multipartUpload:{uploadId:'upload',partSize:5,contentType:'video/mp4'},uploadedAt:'2026-11-13T00:00:00.000Z',uploadHeartbeatAt:'2026-11-13T01:00:00.000Z',uploadUsagePeriodStart:'2026-11-01T00:00:00.000Z'}});
  });
  it('does not resolve another owner, installation, external identity or injected SQL',async()=>{
   expect(await getLmsResource(f.env,{...grant,ownerUserId:'other'},'source')).toBeNull();expect(await getLmsResource(f.env,{...grant,id:'missing'},'source')).toBeNull();
   expect(await getLmsResource(f.env,grant,'missing')).toBeNull();expect(await getLmsResource(f.env,grant,"source' OR 1=1 --")).toBeNull();
  });
  it('rechecks connection and account revocation on every request',async()=>{
   await f.execute('UPDATE lms_installations SET active=false');expect(await read()).toBeNull();await f.execute('UPDATE lms_installations SET active=true');
   for(const patch of ["is_active=false","is_active=true,deactivated_at='2026-01-01'","deactivated_at=NULL,banned=true,ban_expires='2099-01-01'"]){await f.execute(`UPDATE users SET ${patch} WHERE id='owner'`);expect(await read()).toBeNull();}
   await f.execute("UPDATE users SET ban_expires='2000-01-01' WHERE id='owner'");expect(await read()).not.toBeNull();
  });
  it('derives the teacher owner and does not use the installer as the course authority',async()=>{
   await f.execute("UPDATE users SET is_active=false WHERE id='installer'");
   expect(await getLmsResource(f.env,{id:'school'},'source')).toMatchObject({ownerUserId:'owner',video:{userId:'owner'}});
   await f.execute('UPDATE teaching_connections SET active=false');expect(await read()).toBeNull();
  });
  it('never hydrates another owner media or a course whose ownership no longer matches its teacher',async()=>{
   await f.execute('UPDATE videos SET user_id=? WHERE id=1',['other']);expect(await read()).toMatchObject({resource:{videoId:1},video:null});
   await f.execute('UPDATE video_courses SET user_id=? WHERE id=10',['other']);expect(await read()).toBeNull();
  });
  it('retains disabled source metadata for reconciliation without claiming it is enabled',async()=>{
   await f.execute('UPDATE lms_resources SET enabled=false,sync_error=?',['STORAGE_LIMIT_EXCEEDED']);
   expect(await read()).toMatchObject({resource:{enabled:false,syncError:'STORAGE_LIMIT_EXCEEDED'},video:{id:1,status:'uploading'}});
  });
  it('returns a null source for deleted pointers and course entry resources',async()=>{
   await f.execute('UPDATE lms_resources SET video_id=NULL');expect(await read()).toMatchObject({resource:{videoId:null},video:null});
   await f.execute("UPDATE lms_resources SET kind='course',content_hash=NULL,content_type=NULL,file_size=NULL");
   expect(await read()).toMatchObject({resource:{kind:'course',courseId:10,videoId:null},video:null});
  });
 });
}
