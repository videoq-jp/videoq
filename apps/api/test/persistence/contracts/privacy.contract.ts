import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Hono} from 'hono';
import {executePrivacyRequest,lmsPrivacyRoutes} from '../../../src/features/lms/privacy-routes';
import {privacyCollections,privacySubject,type privacyRequest} from '../../../src/shared/privacy';
import {ensureNativeSession} from '../../../src/features/lms/native-session';
import {appendCourseHistory} from '../../../src/features/lti/history';
import {privacyFixtureInstallation as installation} from './privacy-seed';
import type {Bindings,AppEnv} from '../../../src/types/bindings';
import type {z} from 'zod';
export type PrivacyFixture={env:Bindings;courseId:number;own:{question:string;reply:string;conversation:string};execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;failErase:()=>Promise<void>;inlineCheckpoint:boolean;dispose:()=>Promise<void>};
type Part={part:null|{id:string;context:string;revision:string;offset:number;total:number;chunk:string};next:null|{after?:string;record?:{id:string;offset:number;revision:string}}};
export function privacyContract(name:string,setup:()=>Promise<PrivacyFixture>){
 describe(`${name} complete privacy recovery contract`,()=>{
  let f:PrivacyFixture,native:Parameters<typeof ensureNativeSession>[1];
  beforeEach(async()=>{
   f=await setup();f.env.LTI_CONFIG=JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,privacyEnabled:true,registrations:[]});
   const own=await privacySubject(installation,'11'),peer=await privacySubject(installation,'22'),expiresAt=new Date(Date.now()+3600000);
   native={ownerUserId:'owner',sessionHash:'6'.repeat(64),markerHash:'7'.repeat(64),nonceHash:'8'.repeat(64),nonceExpiresAt:new Date(Date.now()+60000),expiresAt,
    grant:{transport:'native',registrationId:own.registrationId,registrationHash:'a'.repeat(64),subjectHash:own.subjectHash,deploymentId:'2',contextId:'context',resourceLinkId:'first',courseId:f.courseId,resourceGeneration:1,roles:[],locale:'ja'}};
   await ensureNativeSession(f.env,native);
   for(const [id,kind,payload] of [['peer-session','session',{...peer,contextId:'context'}],['own-feedback','lti-feedback',{sessionHash:native.sessionHash}],['own-log-feedback','lti-feedback',{logId:1}],['peer-feedback','lti-feedback',{sessionHash:'peer-session'}]] as const)
    await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[id,kind,JSON.stringify(payload),expiresAt.toISOString()]);
  });
  afterEach(async()=>{vi.unstubAllGlobals();await f?.dispose();});
  const run=(request:z.infer<typeof privacyRequest>)=>executePrivacyRequest(f.env,installation,request);
  const part=async(collection:typeof privacyCollections[number],cursor?:NonNullable<Part['next']>)=>await run({action:'export',subject:'11',contexts:['context'],collection,...(cursor?{cursor}:{})}) as Part;
  const erase=()=>run({action:'erase',subject:'11',contexts:['context']}) as Promise<{erased:Record<string,number>}>;
  it('discovers namespaces and exports all owned records without peer/authentication data',async()=>{
   expect(await run({action:'catalog'})).toEqual({version:1,collections:privacyCollections,contexts:['@orphan','context'],nextAfter:null});expect(await run({action:'contexts',subject:'11'})).toEqual({contexts:['context'],nextAfter:null});
   expect(await run({action:'users',subjects:['11','22','33'],contexts:['context']})).toEqual({subjects:['11','22']});
   for(const collection of privacyCollections){const result=await part(collection);if(collection==='checkpoint_blobs'&&f.inlineCheckpoint){expect(result.part).toBeNull();continue;}
    expect(result.part).not.toBeNull();expect(result.part!.context).toBe('context');expect(result.part!.chunk).not.toMatch(/peer-private|NEVER EXPORT AUTH|subjectHash|actor_key/);const data=JSON.parse(result.part!.chunk) as Record<string,unknown>;
    if(collection==='checkpoints')expect(f.inlineCheckpoint?Buffer.from(String(data.metadata),'base64').toString():JSON.stringify(data.metadata)).toContain('own-private-metadata');
    expect(await part(collection,result.next!)).toEqual({part:null,next:null});
   }
  });
  it('erases one actor atomically and prevents in-flight history/session resurrection',async()=>{
   expect(await erase()).toEqual({erased:{sessions:1,feedback:2,recentHistory:1,conversations:1,logs:1,questions:1,replies:1,votes:1,moderation:1,materialOperations:1,tagOperations:1,reportAccesses:1}});
   for(const table of ['chat_logs','chat_log_evaluations','chat_conversations','chat_conversation_turns','checkpoints','checkpoint_writes','lti_material_operations','lti_course_tag_operations','lti_report_accesses'])expect(await f.count(table)).toBe(1);
   expect(await f.count('videos')).toBe(2);expect(await f.count('course_questions')).toBe(2);expect(await f.count('lti_operation_reservations')).toBe(2);
   expect(await run({action:'contexts',subject:'11'})).toEqual({contexts:[],nextAfter:null});expect(await run({action:'contexts',subject:'22'})).toEqual({contexts:['context'],nextAfter:null});
   const subject=await privacySubject(installation,'11');await expect(appendCourseHistory(f.env,{...subject,courseId:f.courseId,sessionProof:{sessionHash:native.sessionHash,registrationId:subject.registrationId,subjectHash:subject.subjectHash}},'late',1,[])).rejects.toMatchObject({status:403});
   await expect(ensureNativeSession(f.env,{...native,nonceHash:'9'.repeat(64)})).rejects.toMatchObject({status:403});
   expect(Object.values((await erase()).erased).every(n=>n===0)).toBe(true);
  });
  it('rolls back sessions, model memory and replay barriers when a late erasure step fails',async()=>{
   await f.failErase();await expect(erase()).rejects.toThrow('erase failure');for(const table of ['chat_logs','chat_conversations','checkpoints','checkpoint_writes','lti_material_operations'])expect(await f.count(table)).toBe(2);expect(await f.count('lti_operation_reservations')).toBe(0);expect((await part('logs')).part).not.toBeNull();await expect(ensureNativeSession(f.env,{...native,nonceHash:'9'.repeat(64)})).resolves.toBeUndefined();
  });
  it('exports separate threads sharing a public UUID and explicitly rejects legacy UUID cursors',async()=>{
   const subject=await privacySubject(installation,'11');await f.execute("INSERT INTO chat_conversations(thread_id,owner_user_id,course_id,conversation_id,expires_at,title) VALUES('second-thread','owner',?,?,?,'Second owned thread')",[f.courseId,f.own.conversation,new Date(Date.now()+60000).toISOString()]);
   await f.execute("INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids) VALUES('second-thread',?,'[]')",[subject.subjectKey]);
   const first=await part('conversations'),second=await part('conversations',first.next!);expect(first.part!.id).not.toBe(second.part!.id);expect(await part('conversations',second.next!)).toEqual({part:null,next:null});
   await expect(part('conversations',{after:f.own.conversation})).rejects.toMatchObject({status:409});
  });
  it('preserves full Unicode export fragments and rejects changed continuation records',async()=>{
   const question='漢😀'.repeat(40000);await f.execute('UPDATE chat_logs SET question=? WHERE id=1',[question]);let result=await part('logs'),text='';const first=result;
   while(result.part){text+=result.part.chunk;if(result.next?.record)result=await part('logs',result.next);else break;}
   expect((JSON.parse(text) as {question:string}).question).toBe(question);await f.execute("UPDATE chat_logs SET question='changed' WHERE id=1");await expect(part('logs',first.next!)).rejects.toMatchObject({status:409});
  });
  it('supports inactive recovery but rejects changed registrations without deleting data',async()=>{
   await f.execute("UPDATE lms_installations SET active=false WHERE id='school'");await f.execute("UPDATE users SET is_active=false,banned=true WHERE id='owner'");expect((await part('logs')).part).not.toBeNull();
   await f.execute("UPDATE lms_installations SET jwks_url='https://changed.example/jwks' WHERE id='school'");await expect(erase()).rejects.toMatchObject({status:403});expect(await f.count('chat_logs')).toBe(2);
  });
  it('runs the signed public Hono route through the selected backend and rejects assertion replay',async()=>{
   const pair=await generateKeyPair('RS256'),url='https://lms.example/jwks-'+crypto.randomUUID();await f.execute('UPDATE lms_installations SET jwks_url=? WHERE id=\'school\'',[url]);
   const jwk={...await exportJWK(pair.publicKey),kid:'privacy-route',alg:'RS256'};
   vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{expect(input instanceof Request?input.url:input.toString()).toBe(url);return Response.json({keys:[jwk]});});
   const sign=(request:z.infer<typeof privacyRequest>)=>new SignJWT({deploymentId:'2',version:1,request}).setProtectedHeader({alg:'RS256',kid:'privacy-route',typ:'videoq-privacy+jwt'}).setIssuer(installation.issuer).setSubject(installation.clientId).setAudience('https://api.example/api/lms/privacy').setIssuedAt().setExpirationTime('60s').setJti(crypto.randomUUID()).sign(pair.privateKey);
   const app=new Hono<AppEnv>();app.route('/api/lms/privacy',lmsPrivacyRoutes);
   const request=(assertion:string)=>app.request('https://api.example/api/lms/privacy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assertion})},f.env);
   const assertion=await sign({action:'contexts',subject:'11'}),first=await request(assertion);expect(first.status).toBe(200);expect(await first.json()).toEqual({contexts:['context'],nextAfter:null});expect((await request(assertion)).status).toBe(403);
   const erased=await request(await sign({action:'erase',subject:'11',contexts:['context']}));expect(erased.status).toBe(200);expect(await erased.json()).toMatchObject({erased:{sessions:1,logs:1,conversations:1}});
  });
 });
}
