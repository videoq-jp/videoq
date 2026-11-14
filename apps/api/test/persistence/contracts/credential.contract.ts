import {putCredential,putLtiFeedback,readCredential,replaceCredentialPayload} from '../../../src/features/lti/store';
import type {Bindings} from '../../../src/types/bindings';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {CredentialRepository} from '../../../src/persistence/contracts/credential-repository';
type Fixture={env:Bindings;repository:CredentialRepository;execute:(sql:string,args?:unknown[])=>Promise<void>;expiry:(id:string)=>Promise<number|null>;count:()=>Promise<number>;dispose:()=>Promise<void>};
export function credentialContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} credential contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    const future=()=>Date.now()+3600_000;
    const proof={sessionHash:'a'.repeat(64),registrationId:'db:installation',subjectHash:'b'.repeat(64)};
    const session=async()=>{await f.repository.put(proof.sessionHash,'session',{registrationId:proof.registrationId,subjectHash:proof.subjectHash,scopeVideoIds:[1],locale:'ja'},future());};
    it('roundtrips structured payloads and isolates kind and expiry',async()=>{
      const payload={nonce:'secret',context:{course:1},scopeVideoIds:[1,2],flag:true};
      await f.repository.put('login','login',payload,future());expect(await f.repository.read('login','login')).toEqual(payload);
      expect(await f.repository.read('login','session')).toBeNull();expect(await f.repository.read('missing','login')).toBeNull();
      await f.repository.put('expired','login',payload,Date.now()-1000);expect(await f.repository.read('expired','login')).toBeNull();
      await expect(f.repository.put('login','login',{nonce:'replacement'},future())).rejects.toThrow();expect(await f.repository.read('login','login')).toEqual(payload);
    });
    it('replaces only live credentials of the matching kind without extending retention or recreating deletion',async()=>{
      await f.repository.put('refresh','classroom-oauth',{token:'old',removed:true},future());
      const expires=await f.expiry('refresh');
      expect(await replaceCredentialPayload(f.env,'refresh','session',{token:'wrong'})).toBe(false);
      expect(await replaceCredentialPayload(f.env,'refresh','classroom-oauth',{token:'new',scopes:['read']})).toBe(true);
      expect(await f.repository.read('refresh','classroom-oauth')).toEqual({token:'new',scopes:['read']});
      expect(await f.expiry('refresh')).toBe(expires);
      await f.execute("UPDATE lti_credentials SET expires_at=? WHERE id=?",['2000-01-01T00:00:00Z','refresh']);
      expect(await replaceCredentialPayload(f.env,'refresh','classroom-oauth',{token:'expired'})).toBe(false);
      await f.execute('DELETE FROM lti_credentials WHERE id=?',['refresh']);
      expect(await replaceCredentialPayload(f.env,'refresh','classroom-oauth',{token:'deleted'})).toBe(false);
      expect(await f.count()).toBe(0);
    });
    it('allows exactly one concurrent consumption and refuses the wrong kind and expired credentials',async()=>{
      await f.repository.put('one-use','oauth-state',{state:'secret'},future());
      expect(await f.repository.consume('one-use','login')).toBe(false);
      const results=await Promise.all(Array.from({length:8},()=>f.repository.consume('one-use','oauth-state')));expect(results.filter(Boolean)).toHaveLength(1);
      expect(await f.repository.read('one-use','oauth-state')).toBeNull();
      await f.repository.put('expired','login',{},Date.now()-1000);expect(await f.repository.consume('expired','login')).toBe(false);
    });
    it('atomically unions concurrent scope updates without extending expiry or changing other claims',async()=>{
      await session();const expires=await f.expiry(proof.sessionHash);
      await Promise.all([f.repository.recordScopeVideos(proof.sessionHash,[1,2]),f.repository.recordScopeVideos(proof.sessionHash,[1,3,3])]);
      expect((await f.repository.recordScopeVideos(proof.sessionHash,[]))?.sort()).toEqual([1,2,3]);
      expect(await f.expiry(proof.sessionHash)).toBe(expires);
      expect(await f.repository.read(proof.sessionHash,'session')).toMatchObject({locale:'ja',registrationId:proof.registrationId,subjectHash:proof.subjectHash});
      await f.repository.put('wrong-kind','login',{},future());expect(await f.repository.recordScopeVideos('wrong-kind',[9])).toBeNull();
      expect(await f.repository.recordScopeVideos('missing',[9])).toBeNull();
      await f.execute("UPDATE lti_credentials SET expires_at=? WHERE id=?",['2000-01-01T00:00:00Z',proof.sessionHash]);
      expect(await f.repository.recordScopeVideos(proof.sessionHash,[9])).toBeNull();
    });
    it('initializes an empty session scope and removes only expired credentials',async()=>{
      await f.repository.put('session','session',{locale:'ja'},future());expect(await f.repository.recordScopeVideos('session',[])).toEqual([]);
      expect(await f.repository.recordScopeVideos('session',[4,4])).toEqual([4]);
      await f.repository.put('expired','session',{},Date.now()-1000);await f.repository.prune();expect(await f.count()).toBe(1);
      expect(await f.repository.read('session','session')).toMatchObject({locale:'ja',scopeVideoIds:[4]});
    });
    it('does not turn malformed stored scope booleans or null into valid video IDs',async()=>{
      await f.repository.put('boolean','session',{scopeVideoIds:[true]},future());
      expect(await f.repository.recordScopeVideos('boolean',[2])).toBeNull();
      const row=await f.repository.read('boolean','session');expect(row?.scopeVideoIds).toContain(true);
      await f.repository.put('null','session',{scopeVideoIds:null},future());
      expect(await f.repository.recordScopeVideos('null',[2])).toBeNull();
    });
    it('saves a feedback reference only while the original session proof remains live',async()=>{
      await session();await f.repository.putFeedback('feedback',proof,1,42,future());
      expect(await f.repository.read('feedback','lti-feedback')).toEqual({sessionHash:proof.sessionHash,courseId:1,logId:42});
      await f.execute('DELETE FROM lti_credentials WHERE id=?',[proof.sessionHash]);
      await expect(f.repository.putFeedback('late',proof,1,42,future())).rejects.toMatchObject({status:403});
      expect(await f.repository.read('late','lti-feedback')).toBeNull();
    });
    it('refuses feedback with expired, substituted or malformed proofs and missing courses',async()=>{
      await session();
      for(const changed of [{...proof,registrationId:'different'},{...proof,subjectHash:'c'.repeat(64)},{...proof,sessionHash:'invalid'}])
        await expect(f.repository.putFeedback('forbidden',changed,1,42,future())).rejects.toMatchObject({status:403});
      await expect(f.repository.putFeedback('forbidden',proof,999,42,future())).rejects.toMatchObject({status:403});
      await f.execute("UPDATE lti_credentials SET expires_at=? WHERE id=?",['2000-01-01T00:00:00Z',proof.sessionHash]);
      await expect(f.repository.putFeedback('expired',proof,1,42,future())).rejects.toMatchObject({status:403});
      expect(await f.count()).toBe(1);
    });
    it('uses the shared session schema and feedback service through the selected backend',async()=>{
      const payload={registrationId:proof.registrationId,registrationHash:'c'.repeat(64),deploymentId:'deployment',contextId:'context',resourceLinkId:'resource',
        courseId:1,subjectHash:proof.subjectHash,roles:[]};
      await putCredential(f.env,proof.sessionHash,'session',payload,3600);
      await putLtiFeedback(f.env,'service-feedback',proof.sessionHash,1,42);
      expect(await readCredential(f.env,'service-feedback','lti-feedback')).toEqual({sessionHash:proof.sessionHash,courseId:1,logId:42});
      await putCredential(f.env,'malformed','session',{registrationId:'only'},3600);
      await expect(putLtiFeedback(f.env,'rejected','malformed',1,42)).rejects.toMatchObject({status:403});
      expect(await readCredential(f.env,'rejected','lti-feedback')).toBeNull();
    });

  });
}
