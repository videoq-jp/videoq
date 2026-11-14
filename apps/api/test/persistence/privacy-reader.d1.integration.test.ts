import {afterEach,beforeEach,expect,it} from 'vitest';
import {createD1PrivacyFixture} from './privacy-fixture.d1';
import {createD1PrivacyReader} from '../../src/persistence/d1/privacy-reader';
import {privacyCollections,privacySubject,type PrivacyInstallation} from '../../src/shared/privacy';
import {digest} from '../../src/features/lti/store';
let f:Awaited<ReturnType<typeof createD1PrivacyFixture>>,courseId:number,reader:ReturnType<typeof createD1PrivacyReader>;
const installation:PrivacyInstallation={id:'school',ownerUserId:'installer',issuer:'https://lms.example',clientId:'client',deploymentId:'2',jwksUrl:'https://lms.example/jwks'};
const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
const own={question:'',reply:'',conversation:''};
type Part={part:null|{id:string;context:string;offset:number;total:number;revision:string;chunk:string};next:null|{after?:string;record?:{id:string;offset:number;revision:string}}};
const part=async(collection:typeof privacyCollections[number],cursor?:NonNullable<Part['next']>,contexts=['context'])=>await reader.execute(installation,{action:'export',subject:'11',contexts,collection,...(cursor?{cursor}:{})}) as Part;
beforeEach(async()=>{f=await createD1PrivacyFixture();courseId=f.courseId;Object.assign(own,f.own);reader=createD1PrivacyReader(f.database);
});
afterEach(async()=>{await f?.dispose();});
it('exports every stored collection without peer content or authentication credentials',async()=>{
 for(const collection of privacyCollections){
  const result=await part(collection);
  if(collection==='checkpoint_blobs'){expect(result).toEqual({part:null,next:null});continue;}
  expect(result.part?.context).toBe('context');expect(result.part).not.toBeNull();const text=result.part!.chunk;
  expect(text).not.toMatch(/peer-private|NEVER EXPORT AUTH|subjectHash|actor_key/);
  const data=JSON.parse(text) as Record<string,unknown>;
  if(collection==='questions')expect(data).toMatchObject({questionId:own.question,featured:true});
  if(collection==='replies')expect(data).toMatchObject({questionId:own.question,replyId:own.reply});
  if(collection==='conversations')expect(data.conversationId).toBe(own.conversation);
  if(collection==='checkpoints'){expect(Buffer.from(String(data.data),'base64').toString()).toBe('own-private-model-memory');expect(Buffer.from(String(data.metadata),'base64').toString()).toBe('own-private-metadata');}
  if(collection==='checkpoint_writes')expect(Buffer.from(String(data.data),'base64').toString()).toBe('own-private-pending-write');
  expect(await part(collection,result.next!)).toEqual({part:null,next:null});
 }
});
it('discovers only relevant submitted subjects and context namespaces',async()=>{
 expect(await reader.execute(installation,{action:'catalog'})).toEqual({version:1,collections:privacyCollections,contexts:['@orphan','context'],nextAfter:null});
 expect(await reader.execute(installation,{action:'contexts',subject:'11'})).toEqual({contexts:['context'],nextAfter:null});
 expect(await reader.execute(installation,{action:'users',subjects:['11','22','33'],contexts:['context']})).toEqual({subjects:['11','22']});
 expect(await reader.execute(installation,{action:'users',subjects:['11','22'],contexts:['other']})).toEqual({subjects:[]});expect(await part('logs',undefined,['other'])).toEqual({part:null,next:null});
});
it('supports orphan recovery after a context mapping is removed',async()=>{
 await execute('DELETE FROM lms_courses');await execute('DELETE FROM teaching_connections');await execute("DELETE FROM lti_credentials WHERE kind='lti-history'");
 expect(await reader.execute(installation,{action:'contexts',subject:'11'})).toEqual({contexts:['@orphan'],nextAfter:null});expect((await part('logs',undefined,['@orphan'])).part?.context).toBe('@orphan');
});
it('preserves complete Unicode records over multiple code-point chunks',async()=>{
 const question='漢😀'.repeat(40000);await execute('UPDATE chat_logs SET question=? WHERE id=1',[question]);
 let result=await part('logs'),text='',chunks=0;
 while(result.part){const p=result.part;text+=p.chunk;chunks++;expect(Array.from(p.chunk).length).toBeLessThanOrEqual(65536);const last=p.chunk.charCodeAt(p.chunk.length-1),first=p.chunk.charCodeAt(0);expect(last>=0xd800&&last<=0xdbff).toBe(false);expect(first>=0xdc00&&first<=0xdfff).toBe(false);if(result.next?.record)result=await part('logs',result.next);else break;}
 expect(chunks).toBeGreaterThan(1);expect((JSON.parse(text) as {question:string}).question).toBe(question);
});
it('refuses continuation after an export record changes or is deleted',async()=>{
 await execute('UPDATE chat_logs SET question=? WHERE id=1',['漢😀'.repeat(40000)]);const first=await part('logs');expect(first.next?.record).toBeDefined();
 await execute("UPDATE chat_logs SET question='changed' WHERE id=1");await expect(part('logs',first.next!)).rejects.toMatchObject({status:409});
 await execute('DELETE FROM chat_logs WHERE id=1');await expect(part('logs',first.next!)).rejects.toMatchObject({status:409});
});
it('rejects malformed typed cursors without reading another record',async()=>{
 for(const [collection,after] of [['logs','1 OR 1=1'],['questions','not-a-uuid']] as const)await expect(part(collection,{after})).rejects.toMatchObject({status:400});
});
it('allows recovery for inactive accounts but fences stale registered identities',async()=>{
 await execute("UPDATE users SET is_active=false,banned=true WHERE id='owner'");await execute("UPDATE lms_installations SET active=false WHERE id='school'");expect((await part('logs')).part).not.toBeNull();
 await execute("UPDATE lms_installations SET jwks_url='https://changed.example/jwks' WHERE id='school'");await expect(part('logs')).rejects.toMatchObject({status:403});
});
it('blocks live unattributed history until older writers are drained',async()=>{
 await execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('legacy','lti-history','{}',?)",[new Date(Date.now()+60000).toISOString()]);
 await expect(reader.execute(installation,{action:'catalog'})).rejects.toMatchObject({status:503,code:'PRIVACY_UPGRADE_PENDING'});
 await execute("UPDATE lti_credentials SET expires_at='2000-01-01' WHERE id='legacy'");expect((await part('logs')).part).not.toBeNull();
});
it('paginates the catalog without dropping or duplicating context names',async()=>{
 const entries=Array.from({length:102},(_,i)=>({id:crypto.randomUUID(),context:`page-${String(i).padStart(3,'0')}`}));
 await execute("INSERT INTO lms_courses(id,installation_id,context_id,course_id) SELECT json_extract(value,'$.id'),'school',json_extract(value,'$.context'),? FROM json_each(?)",[courseId,JSON.stringify(entries)]);
 type Page={contexts:string[];nextAfter:string|null};
 const first=await reader.execute(installation,{action:'catalog'}) as Page,second=await reader.execute(installation,{action:'catalog',after:first.nextAfter!}) as Page;
 expect(first.contexts).toHaveLength(100);expect(second.nextAfter).toBeNull();expect([...first.contexts,...second.contexts]).toEqual(['@orphan','context',...entries.map(e=>e.context)]);
});
function beforeReadBatch(database:D1Database,hook:()=>Promise<void>):D1Database{
 let pending=true;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending){pending=false;await hook();}return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
it('recomputes author identities when an owned course appears during scope preparation',async()=>{
 reader=createD1PrivacyReader(beforeReadBatch(f.database,async()=>{
  const id=courseId+1000,at=new Date().toISOString(),s=await privacySubject(installation,'11'),qa=await digest(JSON.stringify(['lti-course-qa-v1',s.registrationId,s.subjectHash,id]));
  await execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(?,'New private course','',?,?,'owner',1)",[id,at,at]);
  await execute("INSERT INTO course_questions(id,course_id,title,body,lti_author_id) VALUES(?,?,'Own new question','Own new body',?)",[crypto.randomUUID(),id,qa]);
 }));
 expect(await reader.execute(installation,{action:'contexts',subject:'11'})).toEqual({contexts:['@orphan','context'],nextAfter:null});
});
for(const change of ['keys','legacy'])it(`refuses ${change} changed immediately before the privacy read snapshot`,async()=>{
 reader=createD1PrivacyReader(beforeReadBatch(f.database,()=>change==='keys'?execute("UPDATE lms_installations SET jwks_url='https://changed.example/jwks' WHERE id='school'"):
  execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('late-legacy','lti-history','{}',?)",[new Date(Date.now()+60000).toISOString()])));
 await expect(part('logs')).rejects.toMatchObject({status:change==='keys'?403:503});
});
it('exports distinct scoped threads even when their public conversation UUID is reused',async()=>{
 const s=await privacySubject(installation,'11');
 await execute("INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,course_id,title,expires_at) VALUES('own-thread-2',?,'owner',?,'Own second scoped conversation',?)",[own.conversation,courseId,new Date(Date.now()+86400000).toISOString()]);
 await execute("INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids) VALUES('own-thread-2',?,'[]')",[s.subjectKey]);
 const first=await part('conversations'),second=await part('conversations',first.next!);expect(first.part).not.toBeNull();expect(second.part).not.toBeNull();
 expect(second.part!.id).not.toBe(first.part!.id);expect((JSON.parse(first.part!.chunk) as {conversationId:string}).conversationId).toBe(own.conversation);expect((JSON.parse(second.part!.chunk) as {conversationId:string}).conversationId).toBe(own.conversation);
 expect(await part('conversations',second.next!)).toEqual({part:null,next:null});
});
