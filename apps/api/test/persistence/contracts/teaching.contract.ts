import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ticketSchema,type TeachingTicket} from '../../../src/shared/teaching';
import {readTeachingTicket} from '../../../src/features/teaching/service';
import {digest} from '../../../src/features/lti/store';
import type {TeachingRepository} from '../../../src/persistence/contracts/teaching-repository';
import type {Bindings} from '../../../src/types/bindings';
export type TeachingFixture={env:Bindings;repository:TeachingRepository;execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;failConnect:()=>Promise<void>;dispose:()=>Promise<void>};
export async function seedTeaching(execute:TeachingFixture['execute']){
 for(const id of ['installer','alice','bob'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,false,0,0,0)',[id,id,id+'@example.test']);
 for(const [id,owner,hidden] of [[1,'alice',false],[2,'bob',false],[3,'alice',true]] as const)await execute("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at,native_access_disabled) VALUES(?,?,'Course','',0,'2026-11-13','2026-11-13',?)",[id,owner,hidden]);
 await execute("INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,materials_service) VALUES('school','installer','School','https://lms.example','client','1','https://lms.example/auth','https://lms.example/jwks',?)",[JSON.stringify({tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'})]);
}
export function teachingContract(name:string,setup:()=>Promise<TeachingFixture>){
 describe(`${name} teaching contract`,()=>{
  let f:TeachingFixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const value=(patch:Partial<TeachingTicket>={}):TeachingTicket=>ticketSchema.parse({provider:'moodle',installationId:'school',contextId:'class',teacherSubject:'teacher',teacherName:'Teacher',title:'Class',returnUrl:'https://lms.example/course',resourceLinkId:'entry',...patch});
  async function ticket(patch:Partial<TeachingTicket>={},expires='2099-01-01T00:00:00Z'){
   const secret=crypto.randomUUID(),id=await digest(secret),verified=value(patch);
   await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[id,'teaching-connect',JSON.stringify(verified),expires]);return {id,secret,verified};
  }
  it('consumes a signed bootstrap nonce only once and preserves collisions with other credentials',async()=>{
   const expires=new Date(Date.now()+60_000),results=await Promise.all(Array.from({length:8},()=>f.repository.consumeBootstrapNonce('nonce',expires)));
   expect(results.filter(Boolean)).toHaveLength(1);expect(await f.count('lti_credentials')).toBe(1);
   await f.execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('collision','login','{}',?)",[expires.toISOString()]);
   expect(await f.repository.consumeBootstrapNonce('collision',expires)).toBe(false);expect(await f.count('lti_credentials')).toBe(2);
   expect(await f.repository.consumeBootstrapNonce('expired',new Date('2000-01-01'))).toBe(false);expect(await f.repository.consumeBootstrapNonce('invalid',new Date('invalid'))).toBe(false);
  });
  it('connects an existing owned course without creating or taking installer courses',async()=>{
   const t=await ticket();expect(await readTeachingTicket(f.env,t.secret)).toEqual(t.verified);
   expect(await f.repository.connect(t.id,'alice',t.verified,1)).toEqual({returnUrl:t.verified.returnUrl,courseId:1});
   expect(await f.count('video_courses')).toBe(3);expect(await f.count('lti_credentials')).toBe(0);
   const link=await f.repository.findConnection('moodle','school','class');expect(link).toMatchObject({ownerUserId:'alice',courseId:1,teacherSubject:'teacher',resourceLinkId:'entry',courseTitle:'Course',active:true});
   expect(Number.isFinite(Date.parse(link!.createdAt))).toBe(true);
   await f.execute('UPDATE users SET is_active=false,banned=true WHERE id=?',['installer']);
   expect(await f.repository.findConnection('moodle','school','class')).not.toBeNull();
   expect(await f.repository.findInstallation('school')).toMatchObject({clientId:'client',deploymentId:'1'});
  });
  it.each([undefined,2,3])('refuses missing, foreign or externally restricted selected course %s without consuming the ticket',async course=>{
   const t=await ticket();await expect(f.repository.connect(t.id,'alice',t.verified,course)).rejects.toMatchObject({status:403});
   expect(await f.count('teaching_connections')).toBe(0);expect(await f.count('lti_credentials')).toBe(1);
  });
  it('consumes a ticket at most once under concurrent requests',async()=>{
   const t=await ticket(),results=await Promise.allSettled(Array.from({length:8},()=>f.repository.connect(t.id,'alice',t.verified,1)));
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.count('teaching_connections')).toBe(1);expect(await f.count('lti_credentials')).toBe(0);
  });
  it('allows one teacher to reserve a context and preserves the losing ticket',async()=>{
   const a=await ticket(),b=await ticket({teacherSubject:'co-teacher'});
   const results=await Promise.allSettled([f.repository.connect(a.id,'alice',a.verified,1),f.repository.connect(b.id,'bob',b.verified,2)]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:409}});
   expect(await f.count('teaching_connections')).toBe(1);expect(await f.count('lti_credentials')).toBe(1);
  });
  it('retains disconnected ownership and supports only the original owner and teacher reconnecting',async()=>{
   const t=await ticket();await f.repository.connect(t.id,'alice',t.verified,1);
   const link=(await f.repository.findConnection('moodle','school','class'))!;
   expect(await f.repository.disconnect(link.id,'bob')).toBe(false);expect(await f.repository.disconnect(link.id,'alice')).toBe(true);
   expect(await f.repository.findConnection('moodle','school','class')).toBeNull();
   const foreign=await ticket({teacherSubject:'co-teacher'});await expect(f.repository.connect(foreign.id,'bob',foreign.verified,2)).rejects.toMatchObject({status:409});
   const again=await ticket();await f.repository.connect(again.id,'alice',again.verified);
   expect(await f.repository.findConnection('moodle','school','class')).toMatchObject({id:link.id,courseId:1,active:true});
   expect(await f.repository.connections('alice')).toEqual([{id:link.id,provider:'moodle',contextId:'class',courseId:1,name:'Course',active:true}]);
   expect(await f.repository.connections('bob')).toEqual([]);expect(await f.repository.courses('alice')).toEqual([{id:1,name:'Course'}]);
  });
  it('fences ticket replacement, expiry, account state and site revocation',async()=>{
   const t=await ticket();await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({...t.verified,teacherSubject:'changed'}),t.id]);
   await expect(f.repository.connect(t.id,'alice',t.verified,1)).rejects.toMatchObject({status:403});
   const expired=await ticket({},'2000-01-01T00:00:00Z');await expect(f.repository.connect(expired.id,'alice',expired.verified,1)).rejects.toMatchObject({status:403});
   const fresh=await ticket();await f.execute('UPDATE users SET banned=true WHERE id=?',['alice']);
   await expect(f.repository.connect(fresh.id,'alice',fresh.verified,1)).rejects.toMatchObject({status:403});
   await f.execute('UPDATE users SET banned=false WHERE id=?',['alice']);await f.execute('UPDATE lms_installations SET active=false');
   await expect(f.repository.connect(fresh.id,'alice',fresh.verified,1)).rejects.toMatchObject({status:403});
   expect(await f.count('teaching_connections')).toBe(0);expect(await f.repository.findInstallation('school')).toBeNull();
  });
  it('rolls back ticket consumption when connection persistence fails',async()=>{
   const t=await ticket();await f.failConnect();
   await expect(f.repository.connect(t.id,'alice',t.verified,1)).rejects.toThrow();
   expect(await f.count('lti_credentials')).toBe(1);expect(await f.count('teaching_connections')).toBe(0);
   expect(await readTeachingTicket(f.env,t.secret)).toEqual(t.verified);
  });
  it('separates Classroom and Moodle contexts while retaining the same course ownership rule',async()=>{
   const moodle=await ticket(),classroom=await ticket({provider:'classroom',installationId:'google-client',resourceLinkId:undefined});
   await f.repository.connect(moodle.id,'alice',moodle.verified,1);await f.repository.connect(classroom.id,'bob',classroom.verified,2);
   expect(await f.repository.findConnection('classroom','google-client','class')).toMatchObject({ownerUserId:'bob',courseId:2});
   expect(await f.repository.findConnection('moodle','school','class')).toMatchObject({ownerUserId:'alice',courseId:1});
  });
 });
}
