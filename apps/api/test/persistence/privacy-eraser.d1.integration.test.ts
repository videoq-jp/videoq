import {afterEach,beforeEach,expect,it} from 'vitest';
import {createD1PrivacyFixture,privacyFixtureInstallation as installation} from './privacy-fixture.d1';
import {createD1PrivacyEraser} from '../../src/persistence/d1/privacy-eraser';
import {createD1PrivacyReader} from '../../src/persistence/d1/privacy-reader';
import {privacyCollections,privacySubject} from '../../src/shared/privacy';
import {operationReservationKey} from '../../src/shared/lti-operation-key';
import {digest} from '../../src/features/lti/store';
let f:Awaited<ReturnType<typeof createD1PrivacyFixture>>;
const erase=()=>createD1PrivacyEraser(f.database).execute(installation,{action:'erase',subject:'11',contexts:['context']});
const count=async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'));
beforeEach(async()=>{
 f=await createD1PrivacyFixture();
 for(const [subject,id] of [['11','own-session'],['22','peer-session']]){
  const s=await privacySubject(installation,subject);await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,'session',?,?)",[id,JSON.stringify({...s,contextId:'context'}),new Date(Date.now()+60000).toISOString()]);
  await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,'lti-feedback',?,?)",[id+'-feedback',JSON.stringify({sessionHash:id}),new Date(Date.now()+60000).toISOString()]);
 }
 await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('own-log-feedback','lti-feedback','{\"logId\":1}',?)",[new Date(Date.now()+60000).toISOString()]);
 await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('native-marker','moodle-native-started','{}',?)",[new Date(Date.now()+120000).toISOString()]);
 const peer=await privacySubject(installation,'22'),peerQa=await digest(JSON.stringify(['lti-course-qa-v1',peer.registrationId,peer.subjectHash,f.courseId]));
 await f.execute("INSERT INTO course_question_replies(id,question_id,body,lti_author_id) VALUES(?,?,'Peer reply survives',?)",[crypto.randomUUID(),f.own.question,peerQa]);
 await f.execute('INSERT INTO course_question_lti_votes(question_id,lti_author_id) VALUES(?,?)',[f.own.question,peerQa]);
});
afterEach(async()=>{await f?.dispose();});
it('atomically revokes sessions, erases private copies and anonymizes only the selected actor',async()=>{
 expect(await erase()).toEqual({erased:{sessions:1,feedback:2,recentHistory:1,conversations:1,logs:1,questions:1,replies:1,votes:1,moderation:1,materialOperations:1,tagOperations:1,reportAccesses:1}});
 for(const table of ['chat_logs','chat_log_evaluations','chat_conversations','chat_conversation_turns','conversation_checkpoints','conversation_checkpoint_writes','lti_material_operations','lti_course_tag_operations','lti_report_accesses'])expect(await count(table)).toBe(1);
 expect(await f.database.prepare("SELECT title,body,lti_author_id,featured FROM course_questions WHERE id=?").bind(f.own.question).first()).toMatchObject({title:'[deleted]',body:'[deleted]',lti_author_id:'0'.repeat(64),featured:0});
 expect(await count('videos')).toBe(2);expect(await count('video_courses')).toBe(1);expect(await count('course_question_lti_votes')).toBe(2);
 expect(await f.database.prepare("SELECT count(*) AS n FROM course_question_replies WHERE body='Peer reply survives'").first('n')).toBe(1);
 for(const id of ['peer-session','peer-session-feedback','native-marker','secret'])expect(await f.database.prepare('SELECT id FROM lti_credentials WHERE id=?').bind(id).first()).not.toBeNull();
 expect(await f.database.prepare("SELECT id FROM lti_credentials WHERE id='own-session'").first()).toBeNull();
 const reader=createD1PrivacyReader(f.database);expect(await reader.execute(installation,{action:'contexts',subject:'11'})).toEqual({contexts:[],nextAfter:null});
 for(const collection of privacyCollections)expect(await reader.execute(installation,{action:'export',subject:'11',contexts:['context'],collection})).toEqual({part:null,next:null});
 expect(await count('mutation_receipts')).toBe(0);
});
it('preserves permanent operation barriers and is idempotent after metadata erasure',async()=>{
 const subject=await privacySubject(installation,'11'),expected:string[]=[];
 for(const [table,kind] of [['lti_material_operations','material'],['lti_course_tag_operations','tag']] as const){
  const row=await f.database.prepare(`SELECT id FROM ${table} WHERE actor_key=?`).bind(subject.subjectKey).first<{id:string}>();expected.push(await operationReservationKey(kind,row!.id));
 }
 await erase();const keys=(await f.database.prepare('SELECT key FROM lti_operation_reservations ORDER BY key').all<{key:string}>()).results.map(r=>r.key);expect(keys).toEqual(expected.sort());
 const again=await erase();expect(Object.values(again.erased).every(v=>v===0)).toBe(true);expect(await count('lti_operation_reservations')).toBe(2);
});
it('rolls back sessions, checkpoints, text and new barriers if a late delete fails',async()=>{
 await f.execute("CREATE TRIGGER fail_privacy BEFORE DELETE ON lti_course_tag_operations BEGIN SELECT RAISE(ABORT,'erase failure'); END");
 await expect(erase()).rejects.toThrow('erase failure');
 expect(await f.database.prepare("SELECT id FROM lti_credentials WHERE id='own-session'").first()).not.toBeNull();
 for(const table of ['chat_logs','chat_conversations','conversation_checkpoints','conversation_checkpoint_writes'])expect(await count(table)).toBe(2);
 expect(await f.database.prepare('SELECT body FROM course_questions WHERE id=?').bind(f.own.question).first('body')).toBe('own-private-body');
 expect(await count('lti_operation_reservations')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
});
it('keeps another context and unlinked feedback whose log ID is a boolean',async()=>{
 const id=f.courseId+1000,now=new Date().toISOString(),subject=await privacySubject(installation,'11');
 await f.execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(?,'Orphan','',?,?,'owner',1)",[id,now,now]);
 await f.execute("INSERT INTO chat_logs(id,user_id,course_id,question,response,is_shared_origin,created_at,retrieved_contexts) VALUES(3,'owner',?,'Other context','{\"sources\":[]}',true,?,'[]')",[id,now]);
 await f.execute("INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids) VALUES(3,?,'[]')",[subject.subjectKey]);
 await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('boolean-feedback','lti-feedback','{\"logId\":true}',?)",[new Date(Date.now()+60000).toISOString()]);
 await erase();expect(await count('chat_logs')).toBe(2);expect(await f.database.prepare("SELECT id FROM lti_credentials WHERE id='boolean-feedback'").first()).not.toBeNull();
 expect(await createD1PrivacyReader(f.database).execute(installation,{action:'contexts',subject:'11'})).toEqual({contexts:['@orphan'],nextAfter:null});
});
function beforeEraseCommit(database:D1Database,hook:()=>Promise<void>):D1Database{
 let calls=0;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++calls===2)await hook();return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
it('retries a newly recorded operation rather than erasing it without its permanent barrier',async()=>{
 const subject=await privacySubject(installation,'11'),id=crypto.randomUUID();
 const database=beforeEraseCommit(f.database,()=>f.execute("INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash) VALUES(?,?,?,'create',?)",[id,f.courseId,subject.subjectKey,'a'.repeat(64)]));
 expect(await createD1PrivacyEraser(database).execute(installation,{action:'erase',subject:'11',contexts:['context']})).toMatchObject({erased:{tagOperations:2,materialOperations:1}});
 expect(await count('lti_operation_reservations')).toBe(3);expect(await f.database.prepare('SELECT key FROM lti_operation_reservations WHERE key=?').bind(await operationReservationKey('tag',id)).first()).not.toBeNull();expect(await count('mutation_receipts')).toBe(0);
});
for(const change of ['keys','legacy'])it(`refuses ${change} changed immediately before the erase batch without partial data loss`,async()=>{
 const database=beforeEraseCommit(f.database,()=>change==='keys'?f.execute("UPDATE lms_installations SET jwks_url='https://changed.example/jwks' WHERE id='school'"):
  f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('late-legacy','lti-history','{}',?)",[new Date(Date.now()+60000).toISOString()]));
 await expect(createD1PrivacyEraser(database).execute(installation,{action:'erase',subject:'11',contexts:['context']})).rejects.toMatchObject({status:change==='keys'?403:503});
 expect(await count('chat_logs')).toBe(2);expect(await count('conversation_checkpoints')).toBe(2);expect(await count('lti_operation_reservations')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
 expect(await f.database.prepare("SELECT id FROM lti_credentials WHERE id='own-session'").first()).not.toBeNull();
});
