import {managementContext} from '../../../src/features/lms/providers/moodle/management-context';
import {features} from '../../../src/lib/deployment';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {provisionLmsInstallation,provisionLmsServiceInstallation,authenticateLmsInstallation,rotateLmsSyncToken,disconnectLmsInstallation,listActiveLmsInstallations} from '../../../src/repositories/lms-installation-repository';
import {createMoodlePairingRepository} from '../../../src/persistence/factory';
import {digest,randomSecret} from '../../../src/features/lti/store';
import type {Bindings} from '../../../src/types/bindings';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;hash:(id:string)=>Promise<string|null>;failDisconnect:()=>Promise<void>;dispose:()=>Promise<void>};
export function lmsInstallationContract(name:string,setup:()=>Promise<Fixture>){
 describe(`${name} LMS installation contract`,()=>{
  let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const registration=(id='school',ownerUserId='owner')=>({id,ownerUserId,name:'School',issuer:'https://lms.example',clientId:id,deploymentId:'2',authorizationUrl:'https://lms.example/authorize',jwksUrl:'https://lms.example/jwks'});
  const service={tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'};
  async function pending(){
   const secret=randomSecret(),codeHash=await digest('moodle-pairing:'+secret),ownerKey=await digest('moodle-pairing-owner:owner'),receiptId=await digest('lti-materials-pairing:'+secret);
   const repository=await createMoodlePairingRepository(f.env);
   await repository.issue({ownerUserId:'owner',codeHash,ownerKey,payload:{ownerUserId:'owner',moodleUrl:'https://lms.example',mode:'materials'},expiresAt:Date.now()+600_000});
   return {repository,codeHash,ownerKey,receiptId,input:{secret,issuer:'https://lms.example',clientId:'school',deploymentId:'2',mode:'materials' as const,materialsService:service}};
  }
  it('separates management navigation ownership from connection activity and admin permissions',async()=>{
   const input={issuer:'https://lms.example',clientId:'school',deploymentId:'2'};
   expect(await managementContext(f.env,'missing',input)).toBeNull();
   expect(await managementContext(f.env,'owner',input)).toEqual({connection:{owned:false,active:null},permissions:{account:false,billing:false,systemAdmin:false}});
   await provisionLmsInstallation(f.env,registration('school','other'));
   expect(await managementContext(f.env,'other',input)).toMatchObject({connection:{owned:false,active:null}});
   await f.execute("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at) VALUES(1,'owner','Course','',0,'2026-11-13','2026-11-13')");
   await f.execute("INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id) VALUES('11111111-1111-4111-8111-111111111111','moodle','school','context','teacher','owner',1)");
   expect(await managementContext(f.env,'owner',input)).toEqual({connection:{owned:true,active:true},permissions:{account:true,billing:features(f.env).billing,systemAdmin:false}});
   await f.execute('UPDATE teaching_connections SET active=?',[false]);
   expect(await managementContext(f.env,'owner',input)).toMatchObject({connection:{owned:true,active:false},permissions:{account:true}});
   for(const field of ['issuer','clientId','deploymentId'])expect(await managementContext(f.env,'owner',{...input,[field]:'other'})).toMatchObject({connection:{owned:false,active:null}});
   await f.execute("UPDATE users SET role='admin' WHERE id='other'");
   expect(await managementContext(f.env,'other',input)).toEqual({connection:{owned:false,active:null},permissions:{account:false,billing:false,systemAdmin:true}});
  });
  it('provisions and authenticates with only hashed tokens and lists only active owned connections',async()=>{
   const created=await provisionLmsInstallation(f.env,registration());expect(created.token).toMatch(/^[a-f0-9]{64}$/);
   expect(await f.hash('school')).toBe(await digest(created.token));expect(await f.hash('school')).not.toBe(created.token);
   expect(await authenticateLmsInstallation(f.env,created.token)).toEqual({id:'school',issuer:'https://lms.example',clientId:'school',deploymentId:'2'});
   expect(await listActiveLmsInstallations(f.env,'owner')).toEqual([{id:'school',moodleUrl:'https://lms.example',active:true}]);
   expect(await listActiveLmsInstallations(f.env,'other')).toEqual([]);expect(await authenticateLmsInstallation({} as Bindings,'malformed')).toBeNull();
  });
  it('isolates service installations from push token rotation and authentication',async()=>{
   expect(await provisionLmsServiceInstallation(f.env,{...registration(),materialsService:service})).toEqual({installationId:'school',mode:'service'});
   expect(await f.hash('school')).toBeNull();expect(await authenticateLmsInstallation(f.env,'a'.repeat(64))).toBeNull();
   expect(await rotateLmsSyncToken(f.env,'owner','school')).toBeNull();expect((await listActiveLmsInstallations(f.env,'owner'))[0].id).toBe('school');
  });
  it('rotates atomically without changing LTI identity and rejects foreign ownership',async()=>{
   const first=await provisionLmsInstallation(f.env,registration());expect(await rotateLmsSyncToken(f.env,'other','school')).toBeNull();
   const results=await Promise.all([rotateLmsSyncToken(f.env,'owner','school'),rotateLmsSyncToken(f.env,'owner','school')]);
   expect(await authenticateLmsInstallation(f.env,first.token)).toBeNull();
   const grants=await Promise.all(results.map(r=>authenticateLmsInstallation(f.env,r!.token)));expect(grants.filter(Boolean)).toHaveLength(1);
   expect(grants.find(Boolean)).toMatchObject({clientId:'school',deploymentId:'2'});
  });
  it('keeps installation sync credentials independent of installer state while refusing inactive-account provisioning',async()=>{
   const first=await provisionLmsInstallation(f.env,registration());
   for(const patch of ["is_active=false","is_active=true,deactivated_at='2026-01-01'","deactivated_at=NULL,banned=true,ban_expires='2099-01-01'"]){
    await f.execute(`UPDATE users SET ${patch} WHERE id='owner'`);expect(await authenticateLmsInstallation(f.env,first.token)).toMatchObject({id:'school'});expect(await listActiveLmsInstallations(f.env,'owner')).toEqual([]);
    await expect(provisionLmsInstallation(f.env,registration('inactive'))).rejects.toThrow('Active VideoQ account not found');expect(await disconnectLmsInstallation(f.env,'owner','school')).toBe(false);
   }
   await f.execute("UPDATE users SET ban_expires='2000-01-01' WHERE id='owner'");expect(await authenticateLmsInstallation(f.env,first.token)).not.toBeNull();
  });
  it('revokes pending codes on disconnect while preserving learning credentials and supporting idempotence',async()=>{
   const created=await provisionLmsInstallation(f.env,registration());const code=await pending();
   expect(await disconnectLmsInstallation(f.env,'other','school')).toBe(false);expect(await disconnectLmsInstallation(f.env,'owner','school')).toBe(true);
   expect(await authenticateLmsInstallation(f.env,created.token)).toBeNull();expect(await listActiveLmsInstallations(f.env,'owner')).toEqual([]);
   expect(await f.count('lti_credentials')).toBe(1);expect(await f.count('lms_installations')).toBe(1);
   await expect(code.repository.exchange(code.input,code.codeHash,code.receiptId)).rejects.toMatchObject({status:401});
   expect(await disconnectLmsInstallation(f.env,'owner','school')).toBe(true);expect(await disconnectLmsInstallation(f.env,'owner','missing')).toBe(false);
  });
  it('invalidates retry receipts for a disconnected materials connection',async()=>{
   const code=await pending();const saved=await code.repository.exchange(code.input,code.codeHash,code.receiptId);
   expect(await disconnectLmsInstallation(f.env,'owner',saved.installationId)).toBe(true);
   await expect(code.repository.exchange(code.input,code.codeHash,code.receiptId)).rejects.toMatchObject({status:401});expect(await f.count('lti_credentials')).toBe(1);
  });
  it('does not resurrect a connection when exchange races with disconnection',async()=>{
   await provisionLmsInstallation(f.env,registration());const code=await pending();
   const results=await Promise.allSettled([disconnectLmsInstallation(f.env,'owner','school'),code.repository.exchange(code.input,code.codeHash,code.receiptId)]);
   expect(results[0]).toMatchObject({status:'fulfilled',value:true});
   if(results[1].status==='rejected')expect(results[1].reason).toMatchObject({status:401,code:'INVALID_PAIRING_CODE'});
   expect(await listActiveLmsInstallations(f.env,'owner')).toEqual([]);
   await expect(code.repository.exchange(code.input,code.codeHash,code.receiptId)).rejects.toMatchObject({status:401});
  });
  it('rolls back disconnection if pointer revocation fails',async()=>{
   const created=await provisionLmsInstallation(f.env,registration());await pending();await f.failDisconnect();
   await expect(disconnectLmsInstallation(f.env,'owner','school')).rejects.toThrow();expect(await authenticateLmsInstallation(f.env,created.token)).not.toBeNull();
   expect(await f.count('lti_credentials')).toBe(2);expect(await f.count('mutation_receipts')).toBe(0);
  });
  it('validates provisioning and unique identities before creating duplicate connections',async()=>{
   await expect(provisionLmsInstallation(f.env,{...registration(),jwksUrl:'https://other.example/jwks'})).rejects.toThrow();expect(await f.count('lms_installations')).toBe(0);
   await provisionLmsInstallation(f.env,registration());await expect(provisionLmsInstallation(f.env,{...registration(),id:'duplicate'})).rejects.toThrow();expect(await f.count('lms_installations')).toBe(1);
  });
 });
}
