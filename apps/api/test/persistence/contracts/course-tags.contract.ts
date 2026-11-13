import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {courseTags,courseTagInput,type CourseTagScope} from '../../../src/features/lti/course-tags';
import {operationReservationKey} from '../../../src/shared/lti-operation-key';
import type {HistoryFixture} from './course-history.contract';
export type TagsFixture=HistoryFixture&{count:(table:'lti_course_tag_operations'|'lti_operation_reservations'|'lti_course_video_tags'|'mutation_receipts')=>Promise<number>;failOperation:()=>Promise<void>;seedTags:(count:number)=>Promise<void>};
export function tagsScope(f:HistoryFixture):CourseTagScope{return {installationId:'school',contextId:'context',courseId:f.courseId,ownerUserId:'owner',actorKey:'e'.repeat(64),readableVideoIds:f.videoIds,manage:true,management:f.videoIds.map((videoId,i)=>({videoId,resourceLinkId:['first','second'][i],generation:1}))};}
export function courseTagsContract(name:string,setup:()=>Promise<TagsFixture>){
 describe(`${name} course tags contract`,()=>{
  let f:TagsFixture,scope:CourseTagScope;
  beforeEach(async()=>{f=await setup();scope=tagsScope(f);await f.execute("UPDATE videos SET status='completed'");});afterEach(async()=>{await f?.dispose();});
  const run=(input:unknown,principal=scope)=>courseTags(f.env,principal,courseTagInput.parse(input));
  const list=(principal=scope)=>run({action:'list'},principal);
  const create=(name='Concept',id=crypto.randomUUID(),principal=scope)=>run({action:'create',operationId:id,name,color:'blue'},principal);
  const assign=async(videoId:number,tagIds:string[],principal=scope,revision?:string)=>run({action:'assign',operationId:crypto.randomUUID(),videoId,tagIds,revision:revision??(await list(principal)).videos.find(v=>v.videoId===videoId)!.revision},principal);
  it('creates, assigns, edits and deletes vocabulary with safe replay',async()=>{
   const tag=(await create()).tags[0];expect(tag).toMatchObject({name:'Concept',color:'blue',editable:true,videoIds:[]});
   expect((await assign(f.videoIds[0],[tag.id])).tags[0].videoIds).toEqual([f.videoIds[0]]);
   const updated=await run({action:'update',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision,name:'Revised',color:'green'});
   const input={action:'delete',operationId:crypto.randomUUID(),id:tag.id,revision:updated.tags[0].revision};
   expect((await run(input)).tags).toEqual([]);expect((await run(input)).reused).toBe(true);expect(await f.count('lti_course_video_tags')).toBe(0);expect(await f.count('mutation_receipts')).toBe(0);
  });
  it('projects only readable assignments to learners and hides unused teacher vocabulary',async()=>{
   const tag=(await create()).tags[0];await create('Unused');await assign(f.videoIds[0],[tag.id]);await assign(f.videoIds[1],[tag.id]);
   const learner={...scope,manage:false,management:[],readableVideoIds:[f.videoIds[0]]},result=await list(learner);
   expect(result.tags).toEqual([{...tag,editable:false,videoIds:[f.videoIds[0]]}]);expect(result.videos.map(v=>v.videoId)).toEqual([f.videoIds[0]]);expect(result.canManage).toBe(false);
   expect(JSON.stringify(result)).not.toMatch(/owner|actorKey|installation|resource/);await expect(create('Forbidden',crypto.randomUUID(),learner)).rejects.toMatchObject({status:403});
  });
  it('prevents a partial manager from editing vocabulary shared with an unmanageable source',async()=>{
   const tag=(await create()).tags[0];await assign(f.videoIds[0],[tag.id]);await assign(f.videoIds[1],[tag.id]);
   const partial={...scope,readableVideoIds:[f.videoIds[0]],management:scope.management.slice(0,1)};
   expect((await list(partial)).tags[0].editable).toBe(false);
   await expect(run({action:'update',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision,name:'Forbidden',color:'red'},partial)).rejects.toMatchObject({status:403});
   await expect(run({action:'delete',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision},partial)).rejects.toMatchObject({status:403});
   await assign(f.videoIds[0],[],partial);expect((await list(partial)).tags).toEqual([]);
  });
  it.each(['membership','disabled','generation','owner'])('rechecks current %s before assigning',async field=>{
   const tag=(await create()).tags[0],revision=(await list()).videos[0].revision;
   if(field==='membership')await f.execute('DELETE FROM video_course_members WHERE video_id=?',[f.videoIds[0]]);
   if(field==='disabled')await f.execute('UPDATE lms_resources SET enabled=false WHERE video_id=?',[f.videoIds[0]]);
   if(field==='generation')await f.execute('UPDATE lms_resources SET generation=2 WHERE video_id=?',[f.videoIds[0]]);
   if(field==='owner')await f.execute("UPDATE videos SET user_id='other' WHERE id=?",[f.videoIds[0]]);
   await expect(assign(f.videoIds[0],[tag.id],scope,revision)).rejects.toMatchObject({status:403});expect(await f.count('lti_course_video_tags')).toBe(0);
  });
  it('filters processing sources out of learner lists while keeping manager access',async()=>{
   const tag=(await create()).tags[0];await assign(f.videoIds[0],[tag.id]);await f.execute("UPDATE videos SET status='indexing' WHERE id=?",[f.videoIds[0]]);
   expect((await list({...scope,manage:false,management:[],readableVideoIds:[f.videoIds[0]]})).tags).toEqual([]);expect((await list()).tags).toHaveLength(1);
  });
  it('preserves newer edits and assignments when stale revisions are submitted',async()=>{
   const tag=(await create()).tags[0],revision=(await list()).videos[0].revision;
   await run({action:'update',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision,name:'New',color:'red'});
   await expect(run({action:'delete',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision})).rejects.toMatchObject({status:409});
   await assign(f.videoIds[0],[tag.id]);await expect(assign(f.videoIds[0],[],scope,revision)).rejects.toMatchObject({status:409});expect((await list()).tags[0]).toMatchObject({name:'New',videoIds:[f.videoIds[0]]});
  });
  it('serializes concurrent duplicate creates and binds replay to actor and request contents',async()=>{
   const id=crypto.randomUUID(),results=await Promise.all([create('Concept',id),create('Concept',id)]);expect(results.map(r=>r.reused).sort()).toEqual([false,true]);
   await expect(create('Concept',id,{...scope,actorKey:'a'.repeat(64)})).rejects.toMatchObject({status:409});await expect(create('Changed',id)).rejects.toMatchObject({status:409});
   expect(await f.count('lti_course_tag_operations')).toBe(1);expect(await f.count('lti_operation_reservations')).toBe(1);
  });
  it('rolls back the replay reservation after a duplicate name so the operation can be corrected',async()=>{
   await create();const id=crypto.randomUUID();await expect(create('Concept',id)).rejects.toMatchObject({status:409});
   expect(await f.count('lti_operation_reservations')).toBe(1);expect((await create('Corrected',id)).reused).toBe(false);
  });
  it('rejects retired operation IDs without reapplying content changes',async()=>{
   const id=crypto.randomUUID();await create('Concept',id);await f.execute('DELETE FROM lti_course_tag_operations WHERE id=?',[id]);
   await expect(create('Concept',id)).rejects.toMatchObject({status:409});await expect(create('Concept',id.toUpperCase())).rejects.toMatchObject({status:409});expect((await list()).tags).toHaveLength(1);
   expect(await operationReservationKey('tag',id)).toBe(await operationReservationKey('tag',id.toUpperCase()));
  });
  it('refuses revoked sessions and inactive connections before any mutation',async()=>{
   const sessionProof={sessionHash:'a'.repeat(64),registrationId:'db:school',subjectHash:'d'.repeat(64)},secured={...scope,sessionProof};
   await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[sessionProof.sessionHash,'session',JSON.stringify(sessionProof),new Date(Date.now()+60000).toISOString()]);
   await create('Concept',crypto.randomUUID(),secured);await f.execute('DELETE FROM lti_credentials WHERE id=?',[sessionProof.sessionHash]);
   await expect(list(secured)).rejects.toMatchObject({status:403});await expect(create('Revoked',crypto.randomUUID(),secured)).rejects.toMatchObject({status:403});
   await f.execute("UPDATE lms_installations SET active=false WHERE id='school'");await expect(list()).rejects.toMatchObject({status:403});expect(await f.count('lti_course_tag_operations')).toBe(1);
  });
  it('rolls back tag content and permanent replay barriers when receipt persistence fails',async()=>{
   await f.failOperation();await expect(create()).rejects.toThrow('receipt failure');expect((await list()).tags).toEqual([]);expect(await f.count('lti_operation_reservations')).toBe(0);expect(await f.count('mutation_receipts')).toBe(0);
  });
  it('does not exceed the tag limit when two managers create the final available slot',async()=>{
   await f.seedTags(199);const results=await Promise.allSettled([create('Final A'),create('Final B')]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:413}});
   expect((await list()).tags).toHaveLength(200);expect(await f.count('lti_operation_reservations')).toBe(1);
  });
  it('enforces the 200-tag limit and rejects duplicate assignment IDs',async()=>{
   await f.seedTags(200);await expect(create()).rejects.toMatchObject({status:413});const tag=(await list()).tags[0];
   expect(courseTagInput.safeParse({action:'assign',operationId:crypto.randomUUID(),videoId:f.videoIds[0],tagIds:[tag.id,tag.id],revision:'a'.repeat(64)}).success).toBe(false);
   expect(await f.count('lti_operation_reservations')).toBe(0);
  });
 });
}
