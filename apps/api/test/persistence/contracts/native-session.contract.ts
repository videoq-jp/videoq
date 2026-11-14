import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ensureNativeSession} from '../../../src/features/lms/native-session';
import {recordScopeVideos} from '../../../src/features/lti/store';
import type {NativeSessionInput} from '../../../src/persistence/contracts/native-session-repository';
import type {Bindings} from '../../../src/types/bindings';
export type NativeFixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;rows:()=>Promise<Array<{id:string;kind:string;payload:Record<string,unknown>;expiresAt:string}>>;dispose:()=>Promise<void>};
export const nativeInput=():NativeSessionInput=>({ownerUserId:'owner',sessionHash:'a'.repeat(64),markerHash:'b'.repeat(64),nonceHash:crypto.randomUUID(),nonceExpiresAt:new Date(Date.now()+60_000),expiresAt:new Date(Math.ceil(Date.now()/1000)*1000+3_500_000),
 grant:{transport:'native',registrationId:'db:school',registrationHash:'c'.repeat(64),subjectHash:'d'.repeat(64),deploymentId:'2',contextId:'42',resourceLinkId:'entry',courseId:12,resourceGeneration:1,serviceSubject:'11',roles:[],locale:'ja',scopeVideoIds:[3]}});
export function nativeSessionContract(name:string,setup:()=>Promise<NativeFixture>){
 describe(`${name} native learning session contract`,()=>{
  let f:NativeFixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  it('creates one session across concurrent requests with metadata-free markers and nonces',async()=>{
   const a=nativeInput();await Promise.all([ensureNativeSession(f.env,a),ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID()})]);
   const rows=await f.rows();expect(rows).toHaveLength(4);expect(rows.filter(r=>r.kind==='session')).toHaveLength(1);
   expect(rows.filter(r=>r.kind!=='session').every(r=>JSON.stringify(r.payload)==='{}')).toBe(true);
   expect(rows.find(r=>r.kind==='session')?.expiresAt).toBe(a.expiresAt.toISOString());
   expect(rows.find(r=>r.kind==='moodle-native-started')?.expiresAt).toBe(new Date(a.expiresAt.getTime()+120_000).toISOString());
  });
  it('rejects concurrent reuse of the same signed request',async()=>{
   const a=nativeInput(),results=await Promise.allSettled([ensureNativeSession(f.env,a),ensureNativeSession(f.env,a)]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
   expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:403}});expect(await f.rows()).toHaveLength(3);
  });
  it('preserves accumulated scopes without replacing mutable session metadata',async()=>{
   const a=nativeInput();await ensureNativeSession(f.env,a);
   await Promise.all([recordScopeVideos(f.env,a.sessionHash,[7]),ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID(),grant:{...a.grant,scopeVideoIds:[9],locale:'en',roles:['new']}})]);
   const row=(await f.rows()).find(r=>r.kind==='session')!;
   expect((row.payload.scopeVideoIds as number[]).sort((a,b)=>a-b)).toEqual([3,7]);expect(row.payload.locale).toBe('ja');expect(row.payload.roles).toEqual([]);
  });
  it('does not resurrect a deleted session or consume a nonce after revocation',async()=>{
   const a=nativeInput();await ensureNativeSession(f.env,a);await f.execute('DELETE FROM lti_credentials WHERE id=?',[a.sessionHash]);
   const nonce=crypto.randomUUID();await expect(ensureNativeSession(f.env,{...a,nonceHash:nonce})).rejects.toMatchObject({status:403});
   expect((await f.rows()).some(r=>r.kind==='session'||r.id===nonce)).toBe(false);
  });
  it('does not extend the original lifetime or replace an expired session',async()=>{
   const a=nativeInput();await ensureNativeSession(f.env,a);
   await expect(ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID(),expiresAt:new Date(a.expiresAt.getTime()+1000)})).rejects.toMatchObject({status:403});
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',a.sessionHash]);
   await expect(ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID()})).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(3);
  });
  it.each(['registrationId','registrationHash','subjectHash','deploymentId','contextId','resourceLinkId','courseId','videoId','resourceGeneration','serviceSubject'] as const)('refuses changed %s without recording its nonce',async field=>{
   const a=nativeInput();await ensureNativeSession(f.env,a);
   await expect(ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID(),grant:{...a.grant,[field]:['courseId','videoId','resourceGeneration'].includes(field)?999:'other'}})).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(3);
  });
  it('does not create credentials for a missing owner or an already expired initial session',async()=>{
   await expect(ensureNativeSession(f.env,{...nativeInput(),ownerUserId:'absent'})).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(0);
   await expect(ensureNativeSession(f.env,{...nativeInput(),expiresAt:new Date('2000-01-01')})).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(0);
  });
  it('refuses a session ID collision without creating a marker or nonce',async()=>{
   const a=nativeInput();await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[a.sessionHash,'login','{}',a.expiresAt.toISOString()]);
   await expect(ensureNativeSession(f.env,a)).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(1);
  });
  it('refuses malformed stored scopes and unrelated marker kinds without consuming a nonce',async()=>{
   const a=nativeInput();await ensureNativeSession(f.env,a);
   await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({...a.grant,scopeVideoIds:[true]}),a.sessionHash]);
   await expect(ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID()})).rejects.toMatchObject({status:403});
   await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify(a.grant),a.sessionHash]);
   await f.execute("UPDATE lti_credentials SET kind='login' WHERE id=?",[a.markerHash]);
   await expect(ensureNativeSession(f.env,{...a,nonceHash:crypto.randomUUID()})).rejects.toMatchObject({status:403});expect(await f.rows()).toHaveLength(3);
  });
 });
}
