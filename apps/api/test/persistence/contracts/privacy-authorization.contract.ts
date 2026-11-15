import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,type JWTVerifyGetKey} from 'jose';
import {createPrivacyAuthorizationRepository} from '../../../src/persistence/factory';
import {verifyPrivacyAssertion} from '../../../src/features/lms/privacy-auth';
import type {Bindings} from '../../../src/types/bindings';
export type PrivacyAuthFixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;credentials:()=>Promise<Array<{kind:string;payload:Record<string,unknown>}>>;dispose:()=>Promise<void>};
export const privacyAuthConfig={toolOrigin:'https://api.example',databaseRegistrations:true,privacyEnabled:true,registrations:[]};
export function privacyAuthorizationContract(name:string,setup:()=>Promise<PrivacyAuthFixture>){
 describe(`${name} privacy recovery authorization contract`,()=>{
  let f:PrivacyAuthFixture,pair:Awaited<ReturnType<typeof generateKeyPair>>,resolver:ReturnType<typeof createLocalJWKSet>;
  beforeAll(async()=>{pair=await generateKeyPair('RS256');resolver=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256'}]});});
  beforeEach(async()=>{f=await setup();f.env.LTI_CONFIG=JSON.stringify(privacyAuthConfig);});afterEach(async()=>{await f?.dispose();});
  const identity={issuer:'https://lms.example',clientId:'client',deploymentId:'2'};
  const sign=(patch:Record<string,unknown>={},typ='videoq-privacy+jwt',key=pair.privateKey)=>new SignJWT({iss:identity.issuer,sub:identity.clientId,aud:privacyAuthConfig.toolOrigin+'/api/lms/privacy',deploymentId:'2',version:1,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,jti:crypto.randomUUID(),request:{action:'contexts',subject:'private-learner'},...patch}).setProtectedHeader({alg:'RS256',kid:'fixture',typ}).sign(key);
  it('verifies real signed requests and atomically rejects concurrent JWT replay',async()=>{
   const token=await sign(),results=await Promise.allSettled([verifyPrivacyAssertion(f.env,token,resolver),verifyPrivacyAssertion(f.env,token,resolver)]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:403}});
   expect(await f.credentials()).toEqual([{kind:'lti-privacy-nonce',payload:{installationId:'school',action:'contexts'}}]);expect(JSON.stringify(await f.credentials())).not.toContain('private-learner');
  });
  it('allows recovery after disconnection, deactivation, bans and quota limits',async()=>{
   await f.execute("UPDATE lms_installations SET active=false WHERE id='school'");await f.execute("UPDATE users SET is_active=false,deactivated_at=?,banned=true,is_over_quota=true WHERE id='owner'",[new Date().toISOString()]);
   expect((await verifyPrivacyAssertion(f.env,await sign(),resolver)).installation.id).toBe('school');
  });
  it('does not select verification keys for unknown public identities',async()=>{
   let called=false;const keys:JWTVerifyGetKey=(...args)=>{called=true;return resolver(...args);};
   for(const patch of [{iss:'https://unknown.example'},{sub:'unknown'},{deploymentId:'unknown'}])await expect(verifyPrivacyAssertion(f.env,await sign(patch),keys)).rejects.toMatchObject({status:403});
   expect(called).toBe(false);expect(await f.credentials()).toHaveLength(0);
  });
  it.each(['audience','purpose','expiry','version','signature'])('rejects an invalid signed %s without storing a nonce',async invalid=>{
   let token:string;
   if(invalid==='signature'){const other=await generateKeyPair('RS256');token=await sign({},'videoq-privacy+jwt',other.privateKey);}
   else token=await sign(invalid==='audience'?{aud:'https://other.example/api/lms/privacy'}:invalid==='expiry'?{iat:Math.floor(Date.now()/1000)-300,exp:Math.floor(Date.now()/1000)-200}:invalid==='version'?{version:2}:{},invalid==='purpose'?'JWT':'videoq-privacy+jwt');
   await expect(verifyPrivacyAssertion(f.env,token,resolver)).rejects.toMatchObject({status:403});expect(await f.credentials()).toHaveLength(0);
  });
  it.each(['owner_user_id','issuer','client_id','deployment_id','jwks_url'])('fences a changed registration %s when storing a nonce',async field=>{
   const repository=await createPrivacyAuthorizationRepository(f.env),registration=await repository.findInstallation(identity);if(!registration)throw new Error('missing registration');
   await f.execute(`UPDATE lms_installations SET ${field}=? WHERE id='school'`,[field==='owner_user_id'?'other':field==='deployment_id'?'3':field==='client_id'?'changed':'https://changed.example/keys']);
   expect(await repository.consumeNonce(registration,crypto.randomUUID(),'contexts',new Date(Date.now()+60000))).toBe(false);expect(await f.credentials()).toHaveLength(0);
  });
  it('fences key rotation while the signature resolver is running',async()=>{
   const keys:JWTVerifyGetKey=async(...args)=>{await f.execute("UPDATE lms_installations SET jwks_url='https://changed.example/keys' WHERE id='school'");return resolver(...args);};
   await expect(verifyPrivacyAssertion(f.env,await sign(),keys)).rejects.toMatchObject({status:403});expect(await f.credentials()).toHaveLength(0);
  });
  it('preserves unrelated credentials when the nonce key collides and rejects expired nonce lifetimes',async()=>{
   const repository=await createPrivacyAuthorizationRepository(f.env),registration=await repository.findInstallation(identity);if(!registration)throw new Error('missing registration');
   const nonce=crypto.randomUUID();await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[nonce,'login','{}',new Date(Date.now()+60000).toISOString()]);
   expect(await repository.consumeNonce(registration,nonce,'erase',new Date(Date.now()+60000))).toBe(false);expect(await repository.consumeNonce(registration,crypto.randomUUID(),'erase',new Date('2000-01-01'))).toBe(false);expect(await f.credentials()).toEqual([{kind:'login',payload:{}}]);
  });
  it('requires explicit privacy enablement before any database access',async()=>{
   await expect(verifyPrivacyAssertion({DEPLOYMENT_EDITION:'cloud'} as Bindings,await sign(),resolver)).rejects.toMatchObject({status:503});
   await expect(verifyPrivacyAssertion({...f.env,LTI_CONFIG:JSON.stringify({...privacyAuthConfig,privacyEnabled:false})},await sign(),resolver)).rejects.toMatchObject({status:503});expect(await f.credentials()).toHaveLength(0);
  });
 });
}
